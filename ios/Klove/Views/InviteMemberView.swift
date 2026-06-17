import SwiftUI

/// Invite a consenting adult by link (Nest-style). The operator sends the link by email or text; the
/// adult installs Klove, opens the deep link, and chooses what to share. The token is the source of
/// truth, so the link is shown here too (handy for demos and when delivery fails).
struct InviteMemberView: View {
    let memberId: String
    let memberName: String
    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    /// How to deliver the invite link.
    private enum Channel: String, CaseIterable, Identifiable { case email, sms; var id: String { rawValue } }

    @State private var channel: Channel = .email
    @State private var email = ""
    @State private var phone = ""
    @State private var working = false
    @State private var result: InviteResponse?
    @State private var error: String?

    private let api = APIClient()

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
                        Picker("Send by", selection: $channel) {
                            Text("Email").tag(Channel.email)
                            Text("Text").tag(Channel.sms)
                        }
                        .pickerStyle(.segmented)

                        if channel == .email {
                            TextField("Their email", text: $email)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            TextField("Their phone number", text: $phone)
                                .keyboardType(.phonePad)
                                .textContentType(.telephoneNumber)
                        }
                    }
                    Section {
                        Text("\(memberName) stays in control: they choose to share everything, records only, Apple Health only, appointments only — or nothing.")
                            .font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                    if let error {
                        Section { Text(error).font(.caption).foregroundStyle(.red) }
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
                            .disabled(!canSend || working)
                    }
                }
            }
            .tint(Theme.accent)
        }
    }

    /// Enough digits to be a plausible phone (the backend normalizes to E.164 and is the real gate).
    private var phoneDigits: Int { phone.filter(\.isNumber).count }

    private var canSend: Bool {
        switch channel {
        case .email: return email.contains("@")
        case .sms: return phoneDigits >= 10
        }
    }

    private func send() async {
        working = true
        defer { working = false }
        error = nil
        do {
            let body = InviteBody(
                channel: channel.rawValue,
                email: channel == .email ? email.trimmingCharacters(in: .whitespaces) : nil,
                phone: channel == .sms ? phone.trimmingCharacters(in: .whitespaces) : nil
            )
            result = try await api.post("/members/\(memberId)/invite", body: body)
            store.bumpData()
        } catch {
            self.error = "Couldn't send the invite. Please check the \(channel == .email ? "email address" : "phone number") and try again."
        }
    }

    private struct InviteBody: Encodable {
        let channel: String
        let email: String?
        let phone: String?
    }
}
