import Foundation

@MainActor
@Observable
final class OnboardingModel {
    /// Ordered onboarding steps. After signing in, we collect the user's own details, who they're
    /// setting up for, the family they manage, and the health records to import.
    enum Step: Int, CaseIterable {
        case welcome, value, identify, aboutYou, family, connect, channels

        var isLast: Bool { self == Step.allCases.last }
    }

    /// Who the operator is setting Klove up for — gates whether we ask about family members.
    enum SetupScope: String, CaseIterable, Identifiable {
        case myself, family
        var id: String { rawValue }
        var title: String { self == .myself ? "Just me" : "Me & my family" }
        var subtitle: String {
            self == .myself
                ? "Track your own records, appointments, and medications."
                : "Also coordinate care for kids, a partner, or aging parents."
        }
        var icon: String { self == .myself ? "person.fill" : "person.2.fill" }
    }

    var step: Step = .welcome
    var email: String = UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? ""
    var password: String = ""
    var identifyError: String?

    // About-you step
    var fullName = ""
    var birthDate = Calendar.current.date(byAdding: .year, value: -40, to: Date()) ?? Date()
    var setupFor: SetupScope = .myself
    var savingProfile = false

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

    init() {
        // Resume cleanly: a user who authenticated but didn't finish onboarding (e.g. force-quit)
        // shouldn't be made to re-authenticate — drop them at the details step.
        if AuthService.shared.isAuthenticated || AuthService.shared.isSignedIn {
            step = .aboutYou
            Task { await prefillProfile() }
        }
    }

    // MARK: - Navigation

    func advance() {
        if step == .identify, !saveIdentity() { return }
        goToNext()
    }

    /// Save the user's own details, then continue (skipping the family step when it's just them).
    func saveAboutYouAndAdvance() async {
        savingProfile = true
        defer { savingProfile = false }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        _ = try? await api.putProfile(
            fullName: fullName.trimmingCharacters(in: .whitespaces),
            dob: f.string(from: birthDate),
            phone: nil,
            email: email.isEmpty ? nil : email,
            address: nil,
        )
        goToNext()
    }

    private func goToNext() {
        guard var next = Step(rawValue: step.rawValue + 1) else { return }
        // No family to add when setting up for just yourself — skip straight to records.
        if next == .family, setupFor == .myself { next = .connect }
        step = next
        if step == .connect { Task { await sources.loadSources() } }
    }

    /// Prefill the name/DOB from an existing profile so returning users don't retype.
    private func prefillProfile() async {
        guard fullName.isEmpty else { return }
        guard let p = try? await api.getProfile() else { return }
        if fullName.isEmpty { fullName = p.fullName }
        if let d = p.dob, !d.isEmpty {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
            if let date = f.date(from: d) { birthDate = date }
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
        guard var prev = Step(rawValue: step.rawValue - 1) else { return }
        // Mirror the forward skip: don't land on the family step when it's just them.
        if prev == .family, setupFor == .myself { prev = .aboutYou }
        step = prev
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
