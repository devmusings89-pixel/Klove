import SwiftUI
import AuthenticationServices

/// The invitee side of a family invite: sign in (if needed), then choose exactly what to share with
/// the operator and accept. Backed by POST /invites/:token/accept.
struct AcceptInviteView: View {
    let token: String
    @Environment(\.dismiss) private var dismiss

    // Observe the real auth service so the view re-renders the moment a verified sign-in completes.
    @State private var auth = AuthService.shared
    @State private var shareEverything = true
    @State private var shareRecords = false
    @State private var shareAppleHealth = false
    @State private var shareAppointments = false
    @State private var accessLevel = "manage"
    @State private var working = false
    @State private var done = false
    @State private var error: String?
    private let api = APIClient()

    // Acceptance must be tied to a *verified* identity: the backend now binds the invite to the
    // invited email and only honors a matching, authenticated caller. So we require a real sign-in
    // (Sign in with Apple / Google) — not a hand-typed email — before showing the accept controls.
    private var signedIn: Bool { auth.isSignedIn }

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    Section { Label("You're connected", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.handled) }
                } else if !signedIn {
                    identitySection
                } else {
                    shareSection
                    accessSection
                    if let error { Section { Text(error).font(.caption).foregroundStyle(.red) } }
                }
            }
            .navigationTitle("Join on Klove")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(done ? "Done" : "Cancel") { dismiss() } }
                if signedIn && !done {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Accept") { Task { await accept() } }.disabled(working || selectedCategories.isEmpty)
                    }
                }
            }
            .tint(Theme.accent)
        }
    }

    private var identitySection: some View {
        Section {
            Text("Sign in so Klove can verify it's really you, then choose what to share. The invite is tied to your verified identity, so a real sign-in is required to accept.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
            SignInWithAppleButton(.signIn) { AuthService.shared.configure($0) } onCompletion: { AuthService.shared.handle($0) }
                .signInWithAppleButtonStyle(.black).frame(height: 46).clipShape(Capsule())
            Button { Task { await AuthService.shared.signInWithGoogle() } } label: {
                Label("Continue with Google", systemImage: "globe").frame(maxWidth: .infinity)
            }
        } header: { Text("Who are you?") }
    }

    private var shareSection: some View {
        Section {
            Toggle("Everything", isOn: $shareEverything)
            if !shareEverything {
                Toggle("Medical records", isOn: $shareRecords)
                Toggle("Apple Health", isOn: $shareAppleHealth)
                Toggle("Appointments", isOn: $shareAppointments)
            }
        } header: { Text("What to share") } footer: {
            Text("You stay in control — you can change or revoke this anytime.")
        }
    }

    private var accessSection: some View {
        Section("Let them") {
            Picker("Access", selection: $accessLevel) {
                Text("View").tag("view"); Text("Manage").tag("manage"); Text("Operate").tag("operate")
            }.pickerStyle(.segmented)
        }
    }

    private var selectedCategories: [String] {
        if shareEverything { return ["all"] }
        var cats: [String] = []
        if shareRecords { cats.append("records") }
        if shareAppleHealth { cats.append("apple_health") }
        if shareAppointments { cats.append("appointments") }
        return cats
    }

    private func accept() async {
        working = true
        defer { working = false }
        do {
            try await api.acceptInvite(token: token, categories: selectedCategories, accessLevel: accessLevel)
            done = true
        } catch {
            // 403 → the signed-in identity doesn't match who was invited; 410 → expired; 404 → used.
            if case let AppError.server(status, _) = error {
                switch status {
                case 403: self.error = "This invite was sent to a different account. Sign in as the invited person to accept."
                case 410: self.error = "This invite has expired. Ask whoever invited you to send a new one."
                default: self.error = "Couldn't accept the invite. It may have already been used."
                }
            } else {
                self.error = "Couldn't accept the invite. Please try again."
            }
        }
    }
}
