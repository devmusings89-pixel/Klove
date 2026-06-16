import SwiftUI

/// Shown when a session is `awaiting_choice`: the patient picks one of the offered slots,
/// grouped by office. Picking triggers the booking callback, then returns to progress.
struct ChoiceView: View {
    let sessionId: String

    @Environment(Router.self) private var router
    @State private var options: [AggregatedOption] = []
    @State private var submitting = false
    @State private var errorMessage: String?
    private let api = APIClient()

    var body: some View {
        List {
            Section {
                Text("Your preferred times weren't available. Pick a time and we'll call the office back to book it.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ForEach(groupedByOffice, id: \.office) { group in
                Section(group.office) {
                    ForEach(group.options) { option in
                        Button { Task { await choose(option) } } label: {
                            HStack {
                                Text(option.slot)
                                Spacer()
                                if submitting { ProgressView() } else { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
                            }
                        }
                        .disabled(submitting)
                    }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Choose a time")
        .task { await load() }
    }

    private var groupedByOffice: [(office: String, options: [AggregatedOption])] {
        let groups = Dictionary(grouping: options, by: \.officeName)
        return groups
            .map { (office: $0.key, options: $0.value) }
            .sorted { $0.office < $1.office }
    }

    private func load() async {
        do {
            options = try await api.getSession(id: sessionId).aggregatedOptions
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func choose(_ option: AggregatedOption) async {
        submitting = true
        defer { submitting = false }
        do {
            try await api.chooseSlot(sessionId: sessionId, targetId: option.targetId, slot: option.slot)
            // Hand back to the progress screen to watch the booking callback complete.
            router.path.removeLast()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }
}
