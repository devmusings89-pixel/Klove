import Foundation

@MainActor
@Observable
final class OnboardingModel {
    /// Ordered onboarding steps.
    enum Step: Int, CaseIterable {
        case welcome, value, identify, family, connect, channels

        var isLast: Bool { self == Step.allCases.last }
    }

    var step: Step = .welcome
    var email: String = UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? ""
    var password: String = ""
    var identifyError: String?

    /// Source connection is shared with Settings via SourcesModel.
    let sources = SourcesModel()
    private let api = APIClient()

    // Family step
    var newMemberName = ""
    var newMemberType: NewMemberType = .minor
    var addedMembers: [String] = []
    var addingMember = false

    // Channels step
    var pushEnabled = true

    // MARK: - Navigation

    func advance() {
        if step == .identify, !saveIdentity() { return }
        if let next = Step(rawValue: step.rawValue + 1) {
            step = next
            if step == .connect { Task { await sources.loadSources() } }
        }
    }

    /// Add a family member during onboarding (operator identity was set in the identify step).
    func addMember() async {
        let name = newMemberName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        addingMember = true
        defer { addingMember = false }
        if (try? await api.addMember(displayName: name, type: newMemberType)) != nil {
            addedMembers.append(name)
            newMemberName = ""
        }
    }

    func back() {
        if let prev = Step(rawValue: step.rawValue - 1) { step = prev }
    }

    // MARK: - Identity

    /// True when the app is wired to real auth (Supabase). In that case the bare email-entry path is
    /// not a valid identity — the user must authenticate (Apple/Google/email+password) to get a JWT.
    private var requiresRealAuth: Bool { !Config.supabaseURL.isEmpty && !Config.supabaseAnonKey.isEmpty }

    private func saveIdentity() -> Bool {
        // Live build: typing an email alone must not count as being signed in. Require a real token
        // obtained via one of the auth flows (which store an authToken in the Keychain).
        if requiresRealAuth {
            guard AuthService.shared.isSignedIn else {
                identifyError = "Please sign in with Apple, Google, or email and password to continue."
                return false
            }
            identifyError = nil
            return true
        }

        // Mock/dev build: a valid email is a sufficient stable identity (sent via x-user-email).
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("@"), trimmed.contains(".") else {
            identifyError = "Enter a valid email."
            return false
        }
        identifyError = nil
        email = trimmed
        UserDefaults.standard.set(trimmed, forKey: AppStorageKey.userEmail)
        return true
    }

    // MARK: - Finish

    func finish() {
        UserDefaults.standard.set(true, forKey: AppStorageKey.hasOnboarded)
    }
}
