import SwiftUI

/// Conversational booking front-door: say or type "book me a dentist visit", the assistant fills in
/// the details (reusing your past providers), asks only what's missing, then a single confirm card
/// books it via the existing engine.
struct BookingAssistantView: View {
    @Environment(Router.self) private var router
    @State private var model = BookingAssistantModel()
    @State private var speech = SpeechDictation()
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if model.messages.isEmpty { emptyState }
                        ForEach(model.messages) { msg in
                            ChatBubble(message: msg).id(msg.id)
                        }
                        if model.isThinking { TypingIndicator() }
                        if model.showConfirmation { confirmationCard }
                        if let error = model.errorMessage {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote).foregroundStyle(.red)
                        }
                    }
                    .padding()
                }
                .onChange(of: model.messages.count) { _, _ in
                    if let last = model.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            inputBar
        }
        .kloveBackground()
        .navigationTitle("Book a visit")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Use a form") { router.push(.form) }
                    .font(.subheadline)
            }
        }
        .task {
            await model.loadProfile()
            await model.loadRecentProviders()
        }
        // Mirror live dictation into the input field.
        .onChange(of: speech.transcript) { _, new in if speech.isRecording { model.input = new } }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Hi! I can book a doctor's visit for you.")
                    .font(.kloveHeading).foregroundStyle(Theme.ink)
                Text("Tell me what you need in your own words — I'll handle the calls and online booking.")
                    .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
            }
            .padding(.top, 8)

            FlowChips(chips: model.chips) { model.sendChip($0) }

            if !model.recentProviders.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Book again").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                    ForEach(model.recentProviders) { appt in
                        Button { model.rebook(appt) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "arrow.counterclockwise.circle.fill").foregroundStyle(Theme.accent)
                                VStack(alignment: .leading) {
                                    Text(appt.provider ?? "Provider").foregroundStyle(Theme.ink)
                                    Text(appt.title).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var inputBar: some View {
        VStack(spacing: 4) {
            if let err = speech.errorMessage {
                Text(err).font(.caption2).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                TextField(speech.isRecording ? "Listening…" : "Ask to book a visit…", text: $model.input, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Theme.surfaceSunken, in: Capsule())
                    .focused($inputFocused)
                    .onSubmit { Task { await model.send() } }
                if speech.isAvailable {
                    Button { speech.toggle() } label: {
                        Image(systemName: speech.isRecording ? "stop.circle.fill" : "mic.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(speech.isRecording ? .red : Theme.inkSecondary)
                    }
                    .accessibilityLabel(speech.isRecording ? "Stop dictation" : "Dictate request")
                }
                Button {
                    if speech.isRecording { speech.stop() }
                    Task { await model.send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                        .foregroundStyle(Theme.accent)
                }
                .disabled(model.input.trimmingCharacters(in: .whitespaces).isEmpty || model.isThinking)
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private var confirmationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Confirm your booking").font(.kloveHeading).foregroundStyle(Theme.ink)

            summaryRow("Visit", model.draft?.visitLabel ?? "a visit")

            // Office: pick a known provider or use the searched one.
            if let candidates = model.draft?.providerCandidates, !candidates.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Office").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                    ForEach(candidates) { c in
                        Button { model.selectedCandidate = c } label: {
                            HStack {
                                Image(systemName: model.selectedCandidate == c ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(model.selectedCandidate == c ? Theme.accent : Theme.inkSecondary)
                                VStack(alignment: .leading) {
                                    Text(c.officeName).foregroundStyle(Theme.ink)
                                    if let loc = c.location { Text(loc).font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else {
                summaryRow("Office", model.resolvedOfficeName)
            }

            if let times = model.draft?.preferredTimes, !times.isEmpty {
                summaryRow("Preferred times", times)
            }

            Divider().overlay(Theme.hairline)
            Text("Your details").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            TextField("Full name", text: $model.patientName).textContentType(.name)
            TextField("Date of birth (YYYY-MM-DD)", text: $model.patientDob)
            TextField("Email", text: $model.email).textContentType(.emailAddress)
                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Phone (for callbacks)", text: $model.patientPhone)
                .textContentType(.telephoneNumber).keyboardType(.phonePad)

            Divider().overlay(Theme.hairline)
            Text("Insurance (required)").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            TextField("Insurance carrier (e.g. Blue Cross)", text: $model.insuranceCarrier)
                .textInputAutocapitalization(.words)
            TextField("Member ID", text: $model.insuranceMemberId)
                .autocorrectionDisabled()
            TextField("Plan name (optional)", text: $model.insurancePlan)
            if model.insuranceCarrier.trimmingCharacters(in: .whitespaces).isEmpty
                || model.insuranceMemberId.trimmingCharacters(in: .whitespaces).isEmpty {
                Label("Offices ask for insurance to book — please add your carrier and member ID.",
                      systemImage: "exclamationmark.circle.fill")
                    .font(.caption.weight(.medium)).foregroundStyle(Theme.needsYou)
            }

            Button {
                Task { if let sid = await model.book() { router.push(.progress(sessionId: sid)) } }
            } label: {
                HStack {
                    Spacer()
                    if model.isBooking { ProgressView().tint(.white) }
                    else { Text("Confirm & book — it's free").font(.kloveButton) }
                    Spacer()
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .controlSize(.large)
            .disabled(!model.canBook || model.isBooking)
        }
        .padding()
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).stroke(Theme.hairline, lineWidth: 1))
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.kloveCaption).foregroundStyle(Theme.inkSecondary).frame(width: 110, alignment: .leading)
            Text(value).font(.kloveBody).foregroundStyle(Theme.ink)
            Spacer()
        }
    }
}

// MARK: - Pieces

private struct ChatBubble: View {
    let message: ChatMessage
    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 40) }
            Text(message.text)
                .font(.kloveBody)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(message.role == .user ? Theme.accent : Theme.surface,
                            in: RoundedRectangle(cornerRadius: Theme.Radius.lg))
                .foregroundStyle(message.role == .user ? Color.white : Theme.ink)
            if message.role == .assistant { Spacer(minLength: 40) }
        }
    }
}

private struct TypingIndicator: View {
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().tint(Theme.accent)
            Text("Thinking…").font(.kloveBody).foregroundStyle(Theme.inkSecondary)
            Spacer()
        }
    }
}

/// Simple wrapping row of tappable suggestion chips.
private struct FlowChips: View {
    let chips: [String]
    let onTap: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(chips, id: \.self) { chip in
                Button { onTap(chip) } label: {
                    Text(chip)
                        .font(.kloveBody)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Theme.surface, in: Capsule())
                        .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))
                        .foregroundStyle(Theme.ink)
                }
            }
        }
    }
}
