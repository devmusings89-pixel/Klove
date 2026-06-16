import SwiftUI

/// Capture an after-visit summary and turn it into follow-up tasks Klove will track.
struct VisitSummaryView: View {
    let memberId: String
    let memberName: String
    let appointmentId: String

    @Environment(\.dismiss) private var dismiss
    @State private var summary = ""
    @State private var followUps: [String] = [""]
    @State private var saving = false
    private let api = APIClient()

    var body: some View {
        NavigationStack {
            Form {
                Section("What happened at the visit?") {
                    TextField("e.g. Increased metformin to 1000mg; recheck A1c in 3 months.", text: $summary, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section("Follow-ups Klove should track") {
                    ForEach(followUps.indices, id: \.self) { i in
                        TextField("e.g. Schedule A1c recheck", text: $followUps[i])
                    }
                    Button { followUps.append("") } label: {
                        Label("Add a follow-up", systemImage: "plus.circle").foregroundStyle(Theme.accent)
                    }
                }
            }
            .navigationTitle("Visit summary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(summary.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .tint(Theme.accent)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let fu = followUps.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if (try? await api.submitVisitSummary(memberId, appointmentId: appointmentId, summary: summary, followUps: fu)) != nil {
            dismiss()
        }
    }
}
