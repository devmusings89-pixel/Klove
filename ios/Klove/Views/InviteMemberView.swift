import SwiftUI

/// Invite a consenting adult by link (Nest-style). The operator sends an email; the adult installs
/// Klove, opens the deep link, and chooses what to share. The token is the source of truth, so the
/// link is shown here too (handy for demos and when email can't be delivered).
struct InviteMemberView: View {
    let memberId: String
    let memberName: String
    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var working = false
    @State private var result: InviteResponse?

    var body: some View {
        NavigationStack {
            Form {
                if let r = result {
                    Section {
                        Label(r.emailed ? "Invite sent to \(email)" : "Invite ready", systemImage: r.emailed ? "checkmark.circle.fill" : "link")
                            .foregroundStyle(Theme.handled)
                        Text("Share this link with \(memberName) — it opens Klove so they can accept and pick what to share:")
                            .font(.caption).foregroundStyle(Theme.inkSecondary)
                        Text(r.deepLink).font(.footnote.monospaced()).textSelection(.enabled)
                        ShareLink(item: r.deepLink) { Label("Share invite link", systemImage: "square.and.arrow.up") }
                    }
                } else {
                    Section("Invite \(memberName)") {
                        TextField("Their email", text: $email)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    Section {
                        Text("\(memberName) stays in control: they choose to share everything, records only, Apple Health only, appointments only — or nothing.")
                            .font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                }
            }
            .navigationTitle("Invite to Klove")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(result == nil ? "Cancel" : "Done") { dismiss() }
                }
                if result == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send") { Task { await send() } }
                            .disabled(!email.contains("@") || working)
                    }
                }
            }
            .tint(Theme.accent)
        }
    }

    private func send() async {
        working = true
        defer { working = false }
        result = await store.invite(memberId: memberId, email: email.trimmingCharacters(in: .whitespaces))
    }
}
