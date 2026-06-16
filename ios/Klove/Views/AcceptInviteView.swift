import SwiftUI
import AuthenticationServices

/// The invitee side of a family invite: sign in (if needed), then choose exactly what to share with
/// the operator and accept. Backed by POST /invites/:token/accept.
struct AcceptInviteView: View {
    let token: String
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var shareEverything = true
    @State private var shareRecords = false
    @State private var shareAppleHealth = false
    @State private var shareAppointments = false
    @State private var accessLevel = "manage"
    @State private var working = false
    @State private var done = false
    @State private var error: String?
    private let api = APIClient()

    private var signedIn: Bool {
        !(UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "").isEmpty
            || UserDefaults.standard.string(forKey: AppStorageKey.authToken) != nil
    }

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
            Text("Sign in so Klove knows it's you, then choose what to share.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
            SignInWithAppleButton(.signIn) { AuthService.shared.configure($0) } onCompletion: { AuthService.shared.handle($0) }
                .signInWithAppleButtonStyle(.black).frame(height: 46).clipShape(Capsule())
            Button { Task { await AuthService.shared.signInWithGoogle() } } label: {
                Label("Continue with Google", systemImage: "globe").frame(maxWidth: .infinity)
            }
            HStack { TextField("…or your email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Use") { saveEmail() }.disabled(!email.contains("@")) }
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

    private func saveEmail() {
        UserDefaults.standard.set(email.trimmingCharacters(in: .whitespaces), forKey: AppStorageKey.userEmail)
        UserDefaults.standard.set(true, forKey: AppStorageKey.hasOnboarded)
    }

    private func accept() async {
        working = true
        defer { working = false }
        do {
            try await api.acceptInvite(token: token, categories: selectedCategories, accessLevel: accessLevel)
            done = true
        } catch {
            self.error = "Couldn't accept the invite. It may have already been used."
        }
    }
}
