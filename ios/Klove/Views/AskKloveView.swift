import SwiftUI

/// The persistent "Ask Klove" surface — how the operator talks to the agent. Routes ~70/30 between
/// a grounded AI answer and the human concierge (POST /ask).
struct AskKloveView: View {
    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var thinking = false
    @State private var result: AskResult?

    private let api = APIClient()
    private let suggestions = [
        "What's overdue for the kids?",
        "Summarize Dad's recent results",
        "Book my annual physical",
    ]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles").foregroundStyle(Theme.accent)
                    Text("Ask Klove anything about your family's care.")
                        .font(.headline).foregroundStyle(Theme.ink)
                }

                if let r = result {
                    answerCard(r)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(suggestions, id: \.self) { s in
                            Button { text = s } label: {
                                Text(s).font(.subheadline).foregroundStyle(Theme.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                    .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                        }
                    }
                }

                Spacer()
                composer
            }
            .padding(20)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Ask Klove")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func answerCard(_ r: AskResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(r.routedTo == "concierge" ? "Routed to your concierge" : "Klove",
                  systemImage: r.routedTo == "concierge" ? "person.fill.badge.plus" : "sparkles")
                .font(.caption.weight(.semibold))
                .foregroundStyle(r.routedTo == "concierge" ? Theme.waiting : Theme.accent)
            Text(r.answer).font(.subheadline).foregroundStyle(Theme.ink)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private var composer: some View {
        HStack {
            TextField("Ask or say what you need…", text: $text, axis: .vertical)
                .textFieldStyle(.plain).padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            Button { Task { await send() } } label: {
                if thinking { ProgressView() }
                else { Image(systemName: "arrow.up.circle.fill").font(.title).foregroundStyle(text.isEmpty ? Theme.inkSecondary : Theme.accent) }
            }
            .disabled(text.isEmpty || thinking)
        }
    }

    private func send() async {
        thinking = true
        defer { thinking = false }
        let q = text
        result = try? await api.ask(q)
        text = ""
    }
}
