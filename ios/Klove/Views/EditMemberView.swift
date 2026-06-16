import SwiftUI

/// Edit a member's name and relationship.
struct EditMemberView: View {
    let memberId: String
    @State var name: String
    @State var relationship: String
    var onSaved: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    private let api = APIClient()

    private let relationships = ["self", "child", "parent", "spouse", "adult", "other"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("Name", text: $name).textInputAutocapitalization(.words) }
                Section("Relationship") {
                    Picker("Relationship", selection: $relationship) {
                        ForEach(relationships, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }
            }
            .navigationTitle("Edit member").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || working)
                }
            }
            .tint(Theme.accent)
        }
    }

    private func save() async {
        working = true; defer { working = false }
        if (try? await api.updateMember(memberId, displayName: name.trimmingCharacters(in: .whitespaces), relationship: relationship)) != nil {
            onSaved(); dismiss()
        }
    }
}
