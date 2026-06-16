import SwiftUI

/// Change what the operator can see/do for a member (consent scope) after the initial grant.
struct EditConsentView: View {
    let memberId: String
    let consent: MemberConsent
    var onSaved: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var everything: Bool
    @State private var records: Bool
    @State private var appleHealth: Bool
    @State private var appointments: Bool
    @State private var accessLevel: String
    @State private var working = false
    private let api = APIClient()

    init(memberId: String, consent: MemberConsent, onSaved: @escaping () -> Void = {}) {
        self.memberId = memberId
        self.consent = consent
        self.onSaved = onSaved
        let cats = Set(consent.categories)
        _everything = State(initialValue: cats.contains("all"))
        _records = State(initialValue: cats.contains("records"))
        _appleHealth = State(initialValue: cats.contains("apple_health"))
        _appointments = State(initialValue: cats.contains("appointments"))
        _accessLevel = State(initialValue: consent.accessLevel ?? "manage")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("What's shared") {
                    Toggle("Everything", isOn: $everything)
                    if !everything {
                        Toggle("Medical records", isOn: $records)
                        Toggle("Apple Health", isOn: $appleHealth)
                        Toggle("Appointments", isOn: $appointments)
                    }
                }
                Section("Access level") {
                    Picker("Access", selection: $accessLevel) {
                        Text("View").tag("view"); Text("Manage").tag("manage"); Text("Operate").tag("operate")
                    }.pickerStyle(.segmented)
                }
            }
            .navigationTitle("Edit sharing").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(working || selected.isEmpty)
                }
            }
            .tint(Theme.accent)
        }
    }

    private var selected: [String] {
        if everything { return ["all"] }
        var c: [String] = []
        if records { c.append("records") }
        if appleHealth { c.append("apple_health") }
        if appointments { c.append("appointments") }
        return c
    }

    private func save() async {
        working = true; defer { working = false }
        if (try? await api.updateConsent(memberId, accessLevel: accessLevel, categories: selected)) != nil {
            onSaved(); dismiss()
        }
    }
}
