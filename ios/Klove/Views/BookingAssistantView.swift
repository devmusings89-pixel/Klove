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
                            Text(error).font(.footnote).foregroundStyle(.red)
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
                    .font(.title3.weight(.semibold))
                Text("Tell me what you need in your own words — I'll handle the calls and online booking.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.top, 8)

            FlowChips(chips: model.chips) { model.sendChip($0) }

            if !model.recentProviders.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Book again").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.recentProviders) { appt in
                        Button { model.rebook(appt) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "arrow.counterclockwise.circle.fill").foregroundStyle(.tint)
                                VStack(alignment: .leading) {
                                    Text(appt.provider ?? "Provider").foregroundStyle(.primary)
                                    Text(appt.title).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
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
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                    .focused($inputFocused)
                    .onSubmit { Task { await model.send() } }
                if speech.isAvailable {
                    Button { speech.toggle() } label: {
                        Image(systemName: speech.isRecording ? "stop.circle.fill" : "mic.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(speech.isRecording ? .red : .secondary)
                    }
                    .accessibilityLabel(speech.isRecording ? "Stop dictation" : "Dictate request")
                }
                Button {
                    if speech.isRecording { speech.stop() }
                    Task { await model.send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                }
                .disabled(model.input.trimmingCharacters(in: .whitespaces).isEmpty || model.isThinking)
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private var confirmationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Confirm your booking").font(.headline)

            summaryRow("Visit", model.draft?.visitLabel ?? "a visit")

            // Office: pick a known provider or use the searched one.
            if let candidates = model.draft?.providerCandidates, !candidates.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Office").font(.caption).foregroundStyle(.secondary)
                    ForEach(candidates) { c in
                        Button { model.selectedCandidate = c } label: {
                            HStack {
                                Image(systemName: model.selectedCandidate == c ? "largecircle.fill.circle" : "circle")
                                VStack(alignment: .leading) {
                                    Text(c.officeName).foregroundStyle(.primary)
                                    if let loc = c.location { Text(loc).font(.caption).foregroundStyle(.secondary) }
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

            Divider()
            Text("Your details").font(.caption).foregroundStyle(.secondary)
            TextField("Full name", text: $model.patientName).textContentType(.name)
            TextField("Date of birth (YYYY-MM-DD)", text: $model.patientDob)
            TextField("Email", text: $model.email).textContentType(.emailAddress)
                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Phone (for callbacks)", text: $model.patientPhone)
                .textContentType(.telephoneNumber).keyboardType(.phonePad)

            Button {
                Task { if let sid = await model.book() { router.push(.progress(sessionId: sid)) } }
            } label: {
                HStack {
                    Spacer()
                    if model.isBooking { ProgressView() } else { Text("Confirm & book — it's free").bold() }
                    Spacer()
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.canBook || model.isBooking)
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 110, alignment: .leading)
            Text(value).font(.subheadline)
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
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(message.role == .user ? Color.accentColor : Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 16))
                .foregroundStyle(message.role == .user ? .white : .primary)
            if message.role == .assistant { Spacer(minLength: 40) }
        }
    }
}

private struct TypingIndicator: View {
    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
            Text("Thinking…").font(.subheadline).foregroundStyle(.secondary)
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
                        .font(.subheadline)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Color(.secondarySystemBackground), in: Capsule())
                        .foregroundStyle(.primary)
                }
            }
        }
    }
}
