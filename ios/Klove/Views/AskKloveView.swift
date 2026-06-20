import SwiftUI

/// The agent surface — how the operator talks to Klove, as a chat. It's a tool-using agent: it searches,
/// checks records/insurance, and SHOWS results as inline cards, proposing state-changing actions (booking)
/// for the user to Confirm. `inTab` renders it as a home tab (no close button); otherwise it's a sheet.
struct AskKloveView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(HouseholdStore.self) private var store

    /// Optional opening question — sent automatically when the view appears.
    var seed: String? = nil
    /// True when hosted as the home tab (hide the close button).
    var inTab = false

    @State private var messages: [AskMessage] = []
    @State private var text = ""
    @State private var thinking = false
    @State private var speech = SpeechDictation()
    @State private var editRecap: BookingRecap?

    private let api = APIClient()
    private let suggestions = [
        "Find a migraine specialist near me that takes my insurance",
        "What's overdue for the kids?",
        "Summarize Dad's recent results",
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.hairline)
            ScrollViewReader { proxy in
                ScrollView {
                    if messages.isEmpty && !thinking {
                        emptyState
                    } else {
                        LazyVStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                            ForEach(messages) { msg in
                                MessageView(message: msg, onConfirm: { Task { await confirm() } }, onEdit: { editRecap = $0 })
                            }
                            if thinking { typingIndicator.id("typing") }
                        }
                        .padding(Theme.Spacing.lg)
                    }
                }
                .onChange(of: messages.count) { scrollToEnd(proxy) }
                .onChange(of: thinking) { scrollToEnd(proxy) }
            }
            composer
        }
        .background(Theme.background.ignoresSafeArea())
        .task { if let seed, messages.isEmpty { await send(seed) } }
        .sheet(item: $editRecap) { recap in
            if let m = store.selectedMember ?? store.actionableMembers.first {
                BookAppointmentView(memberId: m.userId, memberName: m.name, allowMemberChange: true,
                                    initialReason: recap.reason, initialProvider: recap.provider ?? "",
                                    initialPhone: recap.phone ?? "", initialWebsite: recap.website ?? "")
                    .environment(store)
            } else {
                Text("Add a family member first.").padding()
            }
        }
    }

    private var header: some View {
        HStack {
            Text("ask klove.").font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Spacer()
            if !inTab {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.inkSecondary)
                        .frame(width: 32, height: 32).background(Theme.surfaceSunken, in: Circle())
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.lg).padding(.vertical, Theme.Spacing.md)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Tell me what you need — I'll handle it.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
            ForEach(suggestions, id: \.self) { s in
                Button { Task { await send(s) } } label: {
                    Text(s).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                        .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(Theme.Spacing.xl)
    }

    private var typingIndicator: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { _ in Circle().fill(Theme.inkSecondary).frame(width: 7, height: 7) }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var composer: some View {
        HStack(spacing: Theme.Spacing.sm) {
            HStack {
                TextField("Ask anything, or describe what you need", text: $text, axis: .vertical)
                    .textFieldStyle(.plain).font(.kloveBody)
                    .accessibilityIdentifier("ask.input")
                if speech.isAvailable {
                    Button { speech.toggle() } label: {
                        Image(systemName: speech.isRecording ? "stop.circle.fill" : "mic")
                            .font(.system(size: 16)).foregroundStyle(speech.isRecording ? .red : Theme.inkSecondary)
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.surface, in: Capsule())
            .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))

            Button { Task { await send(text) } } label: {
                if thinking { ProgressView().frame(width: 38, height: 38) }
                else {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.background)
                        .frame(width: 38, height: 38)
                        .background(text.isEmpty ? Theme.inkSecondary : Theme.accent, in: Circle())
                }
            }
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || thinking)
            .accessibilityIdentifier("ask.send")
        }
        .padding(.horizontal, Theme.Spacing.lg).padding(.vertical, Theme.Spacing.sm)
        .background(Theme.background)
        .onChange(of: speech.transcript) { _, new in if speech.isRecording { text = new } }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            if thinking { proxy.scrollTo("typing", anchor: .bottom) }
            else { proxy.scrollTo(messages.last?.id, anchor: .bottom) }
        }
    }

    private func send(_ raw: String) async {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !thinking else { return }
        if speech.isRecording { speech.toggle() }
        messages.append(AskMessage(role: .user, text: q))
        text = ""
        thinking = true
        defer { thinking = false }
        if let r = try? await api.ask(q) {
            appendAssistant(r)
        } else {
            messages.append(AskMessage(role: .assistant, text: "I couldn't reach Klove just now. Please try again."))
        }
    }

    /// Confirm the agent's pending proposal (Confirm button on a booking card).
    private func confirm() async {
        guard !thinking else { return }
        thinking = true
        defer { thinking = false }
        clearProposals()
        if let r = try? await api.confirmAsk() { appendAssistant(r) }
    }

    private func appendAssistant(_ r: AskResult) {
        // A fresh proposal supersedes any earlier pending one in the thread.
        if r.proposal != nil { clearProposals() }
        messages.append(AskMessage(role: .assistant, text: r.answer, routedToConcierge: r.routedTo == "concierge",
                                   sources: r.sources, cards: r.cards ?? [], proposal: r.proposal))
    }

    private func clearProposals() {
        for i in messages.indices where messages[i].proposal != nil { messages[i].proposal = nil }
    }
}

/// One chat message — plus any structured cards and a pending proposal.
struct AskMessage: Identifiable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    let text: String
    var routedToConcierge: Bool = false
    var sources: [String]? = nil
    var cards: [AgentCard] = []
    var proposal: AskProposal? = nil
}

/// Renders a message: the bubble, any inline cards, and Confirm/Edit when a proposal is pending.
struct MessageView: View {
    let message: AskMessage
    var onConfirm: () -> Void
    var onEdit: (BookingRecap) -> Void
    @State private var showSources = false

    var body: some View {
        if message.role == .user {
            HStack { Spacer(minLength: 40); bubble(Theme.accent, Theme.background) }
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if !message.text.isEmpty { bubble(Theme.surfaceSunken, Theme.ink) }
                ForEach(Array(message.cards.enumerated()), id: \.offset) { _, card in cardView(card) }
                if let p = message.proposal, p.tool == "book_appointment" { confirmRow }
                if let sources = message.sources, !sources.isEmpty { sourcesExpander(sources) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 40)
        }
    }

    private func bubble(_ fill: Color, _ fg: Color) -> some View {
        Text(markdown(message.text))
            .font(.kloveBody).foregroundStyle(fg)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(fill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Render the agent's markdown (bold, bullets) instead of showing literal ** and - characters.
    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    // MARK: Cards

    @ViewBuilder
    private func cardView(_ card: AgentCard) -> some View {
        switch card {
        case let .physicianList(_, memberInsurance, results):
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(results.prefix(5)) { r in physicianCard(r, carrier: memberInsurance.first) }
            }
        case let .bookingRecap(recap):
            recapCard(recap)
        case let .bookingStatus(sessionId, _, _):
            SessionLiveCard(sessionId: sessionId)   // live call progress: calling → booked / no-answer fallback
        case let .prepList(title, questions):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.kloveBodyStrong).foregroundStyle(Theme.ink) }
                ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                    Text("\(i + 1). \(q)").font(.kloveBody).foregroundStyle(Theme.inkSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).kloveCard()
        case let .text(t):
            Text(t).font(.kloveBody).foregroundStyle(Theme.inkSecondary)
        case .unknown:
            EmptyView()
        }
    }

    private func physicianCard(_ r: PhysicianResult, carrier: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Text(r.name).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                Spacer()
                NetworkBadge(status: r.networkStatus, carrier: carrier)
            }
            if let tax = r.taxonomyDesc { Text(tax).font(.caption).foregroundStyle(Theme.inkSecondary) }
            HStack(spacing: 10) {
                if let rating = r.rating {
                    Text(String(format: "%.1f★ · %d", rating, r.reviewCount ?? 0)).font(.caption).foregroundStyle(Theme.ink)
                }
                if let mi = r.distanceMiles {
                    Label(String(format: "%.1f mi", mi), systemImage: "mappin.and.ellipse").font(.caption).foregroundStyle(Theme.inkSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private func recapCard(_ recap: BookingRecap) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Booking", systemImage: "calendar.badge.plus").font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.accent)
            Text(recap.reason.capitalizedFirst).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
            if let p = recap.provider, !p.isEmpty { Label(p, systemImage: "stethoscope").font(.caption).foregroundStyle(Theme.inkSecondary) }
            Label("For \(recap.memberName)", systemImage: "person.fill").font(.caption).foregroundStyle(Theme.inkSecondary)
            if let ins = recap.insurance, !ins.isEmpty { Label(ins, systemImage: "creditcard").font(.caption).foregroundStyle(Theme.inkSecondary) }
            if let t = recap.preferredTimes, !t.isEmpty { Label(t, systemImage: "clock").font(.caption).foregroundStyle(Theme.inkSecondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).kloveCardSunken()
    }

    private var confirmRow: some View {
        HStack(spacing: Theme.Spacing.md) {
            Button { onConfirm() } label: { Label("Confirm & book", systemImage: "checkmark.circle.fill") }
                .buttonStyle(KlovePrimaryButtonStyle())
            if let recap = message.cards.compactMap(asRecap).first {
                Button("Edit") { onEdit(recap) }.font(.caption.weight(.semibold)).tint(Theme.accent)
            }
        }
    }

    private func asRecap(_ card: AgentCard) -> BookingRecap? {
        if case let .bookingRecap(r) = card { return r }
        return nil
    }

    private func sourcesExpander(_ sources: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { showSources.toggle() } } label: {
                HStack(spacing: 6) {
                    Text("Sources (\(sources.count))").font(.kloveLabel).textCase(.uppercase).tracking(Theme.Tracking.label)
                    Image(systemName: showSources ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(Theme.inkSecondary)
            }
            .buttonStyle(.plain)
            if showSources {
                ForEach(sources, id: \.self) { s in Text("· \(s)").font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
            }
        }
        .padding(.leading, 4)
    }
}

private extension String {
    var capitalizedFirst: String { isEmpty ? self : prefix(1).uppercased() + dropFirst() }
}

// BookingRecap is Identifiable for the .sheet(item:) edit presentation.
extension BookingRecap: Identifiable {
    var id: String { "\(reason)|\(provider ?? "")|\(memberName)" }
}
