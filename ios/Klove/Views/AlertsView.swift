import SwiftUI

/// Lists health alerts surfaced by the analysis pass. Swipe or tap to acknowledge.
struct AlertsView: View {
    @State private var model = AlertsModel()

    var body: some View {
        List {
            if model.active.isEmpty && !model.isLoading {
                Section {
                    ContentUnavailableView("You're all caught up",
                                           systemImage: "checkmark.seal.fill",
                                           description: Text("New things to be aware of will appear here as your records update."))
                }
            }

            if !model.active.isEmpty {
                Section("Needs attention") {
                    ForEach(model.active) { alert in
                        AlertRow(alert: alert)
                            .swipeActions {
                                Button("Dismiss", systemImage: "checkmark") { Task { await model.acknowledge(alert) } }
                                    .tint(.green)
                            }
                    }
                }
            }

            let resolved = model.alerts.filter(\.isAcknowledged)
            if !resolved.isEmpty {
                Section("Dismissed") {
                    ForEach(resolved) { alert in
                        AlertRow(alert: alert).opacity(0.55)
                    }
                }
            }

            if let error = model.errorMessage {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Alerts")
        .task { await model.load() }
        .refreshable { await model.load() }
    }
}

struct AlertRow: View {
    let alert: HealthAlert

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: HealthFormat.severityIcon(alert.severity))
                .foregroundStyle(HealthFormat.severityColor(alert.severity))
                .font(.title3)
            VStack(alignment: .leading, spacing: 3) {
                Text(alert.title).font(.headline)
                Text(alert.detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
