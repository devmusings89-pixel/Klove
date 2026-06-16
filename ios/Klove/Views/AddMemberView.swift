import SwiftUI

/// Add a person to the household. Minors and aging parents become managed members immediately;
/// a consenting adult is created as a pending member and flows straight into the invite screen.
struct AddMemberView: View {
    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var type: NewMemberType = .minor
    @State private var working = false
    @State private var inviteFor: AddMemberResponse?

    var body: some View {
        NavigationStack {
            Form {
                Section("Who are you adding?") {
                    TextField("Name (e.g. Ava, Dad)", text: $name)
                        .textInputAutocapitalization(.words)
                }
                Section("Their relationship to your household") {
                    ForEach(NewMemberType.allCases) { t in
                        Button { type = t } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: type == t ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(type == t ? Theme.accent : Theme.inkSecondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                                    Text(t.blurb).font(.caption).foregroundStyle(Theme.inkSecondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                if let error = store.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Add member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await add() } }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || working)
                }
            }
            .sheet(item: $inviteFor) { created in
                InviteMemberView(memberId: created.userId, memberName: created.displayName ?? name)
                    .environment(store)
            }
            .tint(Theme.accent)
        }
    }

    private func add() async {
        working = true
        defer { working = false }
        guard let created = await store.addMember(name: name.trimmingCharacters(in: .whitespaces), type: type) else { return }
        if type == .consentingAdult {
            inviteFor = created          // continue into the invite flow
        } else {
            dismiss()                    // managed member is ready immediately
        }
    }
}

// Allow presenting the invite sheet via .sheet(item:).
extension AddMemberResponse: Identifiable {
    public var id: String { userId }
}
