import SwiftUI

/// The persistent "Ask Klove" surface — how the operator talks to the agent, as a chat. Routes ~70/30
/// between a grounded AI answer and the human concierge (POST /ask). Can be opened pre-seeded with a
/// question (e.g. "Ask Klove about this" from a record), which sends immediately.
struct AskKloveView: View {
    @Environment(\.dismiss) private var dismiss

    /// Optional opening question — sent automatically when the view appears.
    var seed: String? = nil

    @State private var messages: [AskMessage] = []
    @State private var text = ""
    @State private var thinking = false

    private let api = APIClient()
    private let suggestions = [
        "What's overdue for the kids?",
        "Summarize Dad's recent results",
        "Book my annual physical",
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
                            ForEach(messages) { MessageBubble(message: $0) }
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
        .task {
            if let seed, messages.isEmpty { await send(seed) }
        }
    }

    private var header: some View {
        HStack {
            Text("ask klove.").font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.inkSecondary)
                    .frame(width: 32, height: 32).background(Theme.surfaceSunken, in: Circle())
            }
        }
        .padding(.horizontal, Theme.Spacing.lg).padding(.vertical, Theme.Spacing.md)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Ask anything about your family's care.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
            ForEach(suggestions, id: \.self) { s in
                Button { text = s } label: {
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
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.inkSecondary)
                .frame(width: 38, height: 38).background(Theme.surfaceSunken, in: Circle())

            HStack {
                TextField("Ask anything", text: $text, axis: .vertical)
                    .textFieldStyle(.plain).font(.kloveBody)
                Image(systemName: "mic").font(.system(size: 15)).foregroundStyle(Theme.inkSecondary)
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
        }
        .padding(.horizontal, Theme.Spacing.lg).padding(.vertical, Theme.Spacing.sm)
        .background(Theme.background)
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
        messages.append(AskMessage(role: .user, text: q))
        text = ""
        thinking = true
        defer { thinking = false }
        if let r = try? await api.ask(q) {
            messages.append(AskMessage(role: .assistant, text: r.answer,
                                        routedToConcierge: r.routedTo == "concierge", sources: r.sources))
        } else {
            messages.append(AskMessage(role: .assistant, text: "I couldn't reach Klove just now. Please try again.",
                                        routedToConcierge: false, sources: nil))
        }
    }
}

/// One chat message.
struct AskMessage: Identifiable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    let text: String
    var routedToConcierge: Bool = false
    var sources: [String]? = nil
}

/// User messages right-aligned in an ink bubble; assistant messages left-aligned in a grey bubble,
/// with an optional collapsible sources list.
struct MessageBubble: View {
    let message: AskMessage
    @State private var showSources = false

    var body: some View {
        if message.role == .user {
            HStack { Spacer(minLength: 40); bubble(Theme.accent, Theme.background) }
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                bubble(Theme.surfaceSunken, Theme.ink)
                if let sources = message.sources, !sources.isEmpty { sourcesExpander(sources) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 40)
        }
    }

    private func bubble(_ fill: Color, _ fg: Color) -> some View {
        Text(message.text)
            .font(.kloveBody).foregroundStyle(fg)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(fill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func sourcesExpander(_ sources: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { showSources.toggle() } } label: {
                HStack(spacing: 6) {
                    Text("Sources (\(sources.count))")
                        .font(.kloveLabel).textCase(.uppercase).tracking(Theme.Tracking.label)
                    Image(systemName: showSources ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(Theme.inkSecondary)
            }
            .buttonStyle(.plain)
            if showSources {
                ForEach(sources, id: \.self) { s in
                    Text("· \(s)").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                }
            }
        }
        .padding(.leading, 4)
    }
}
