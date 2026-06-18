import Foundation

@MainActor
@Observable
final class OnboardingModel {
    /// V1 onboarding (Figma "Lō x Klove V1"): an intro carousel, a passwordless account step, then
    /// three numbered detail steps — About You · Your Care Circle · Notifications — and into the app.
    enum Step: Int, CaseIterable {
        case welcome, identify, aboutYou, careCircle, notifications

        var isLast: Bool { self == .notifications }

        /// 1-based position within the three "STEP X OF 3" detail screens (nil for welcome/identify).
        var detailStep: Int? {
            switch self {
            case .aboutYou: return 1
            case .careCircle: return 2
            case .notifications: return 3
            default: return nil
            }
        }
        /// Centered nav title shown above the progress bar on the detail steps.
        var detailTitle: String? {
            switch self {
            case .aboutYou: return "About You"
            case .careCircle: return "Your Care Circle"
            case .notifications: return "Notifications"
            default: return nil
            }
        }
    }

    var step: Step = .welcome

    // Identify (magic link)
    var email: String = UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? ""
    var agreedToTerms = true
    var magicLinkSent = false
    var authBusy = false
    var identifyError: String?

    // About you
    var fullName = ""
    /// nil until the user picks a date — the field shows the DD/MM/YYYY placeholder until then.
    var birthDate: Date?
    var savingProfile = false

    // Care circle — reuses the real household roster (operator + added members).
    let store = HouseholdStore()

    // Notifications
    var pushEnabled = true
    var textEnabled = true
    var whatsappEnabled = false   // off until a number is connected (the agentic channel needs enroll)
    var emailEnabled = true

    // WhatsApp enrollment — links a number to the concierge agent (POST /whatsapp/enroll).
    var whatsappPhone = ""
    enum WhatsAppEnroll: Equatable { case idle, enrolling, sent, failed(String) }
    var whatsappEnroll: WhatsAppEnroll = .idle

    private let api = APIClient()

    init() {
        // Resume cleanly: a user who authenticated but didn't finish onboarding (e.g. force-quit)
        // shouldn't re-authenticate — drop them at the first detail step.
        if AuthService.shared.isAuthenticated || AuthService.shared.isSignedIn {
            step = .aboutYou
            Task { await prefillProfile() }
        }
    }

    // MARK: - Derived

    /// Whole years from the entered DOB — shown as "You · 50" in the care circle.
    var operatorAge: Int? {
        guard let birthDate else { return nil }
        return Calendar.current.dateComponents([.year], from: birthDate, to: Date()).year
    }

    var aboutYouComplete: Bool {
        !fullName.trimmingCharacters(in: .whitespaces).isEmpty && birthDate != nil
    }

    // MARK: - Navigation

    func advance() { goToNext() }

    func back() {
        guard let prev = Step(rawValue: step.rawValue - 1) else { return }
        step = prev
    }

    private func goToNext() {
        guard let next = Step(rawValue: step.rawValue + 1) else { return }
        step = next
        if step == .careCircle { Task { await store.load() } }
    }

    // MARK: - Identify

    /// Send the magic link / establish identity, then advance to About You.
    func continueWithMagicLink() async {
        authBusy = true
        defer { authBusy = false }
        identifyError = nil
        guard agreedToTerms else {
            identifyError = "Please accept the Terms to continue."
            return
        }
        if await AuthService.shared.sendEmailCode(email) {
            // Mock/dev: identity is set → continue. Live: a 6-digit code is emailed; reveal the
            // code-entry field (verifyCode completes the session, no deep link needed).
            if AuthService.shared.isSignedIn {
                goToNext()
            } else {
                magicLinkSent = true
            }
        } else {
            identifyError = AuthService.shared.errorMessage
        }
    }

    /// The 6-digit code the user typed from the email.
    var code = ""

    /// Verify the emailed 6-digit code → session. On success, the isAuthenticated observer advances.
    func verifyCode() async {
        authBusy = true
        defer { authBusy = false }
        identifyError = nil
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 6 else {
            identifyError = "Enter the 6-digit code from your email."
            return
        }
        if await AuthService.shared.verifyEmailOtp(email, trimmed) {
            goToNext()
        } else {
            identifyError = AuthService.shared.errorMessage
        }
    }

    // MARK: - About you

    /// Save the user's own details (name + DOB), then continue.
    func saveAboutYouAndAdvance() async {
        guard aboutYouComplete else { return }
        savingProfile = true
        defer { savingProfile = false }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        _ = try? await api.putProfile(
            fullName: fullName.trimmingCharacters(in: .whitespaces),
            dob: birthDate.map { f.string(from: $0) },
            phone: nil,
            email: email.isEmpty ? nil : email,
            address: nil,
        )
        goToNext()
    }

    /// Prefill name/DOB from an existing profile so returning users don't retype.
    private func prefillProfile() async {
        guard fullName.isEmpty else { return }
        guard let p = try? await api.getProfile() else { return }
        if fullName.isEmpty { fullName = p.fullName }
        if let d = p.dob, !d.isEmpty {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
            if let date = f.date(from: d) { birthDate = date }
        }
    }

    // MARK: - Notifications

    /// Persist the notification preferences (push is backend-backed; the other channels are captured
    /// for when their delivery lands) and finish onboarding.
    func finishWithNotifications() async {
        savingProfile = true
        defer { savingProfile = false }
        _ = try? await api.updatePreferences(pushEnabled: pushEnabled, reminderLeadHours: 24)
        finish()
    }

    func finish() {
        UserDefaults.standard.set(true, forKey: AppStorageKey.hasOnboarded)
    }

    // MARK: - WhatsApp

    /// Link the entered number to the concierge agent. The backend sends a "reply YES" verification;
    /// the inbound webhook flips the channel to verified, after which the agent handles WhatsApp chats.
    func connectWhatsApp() async {
        let phone = whatsappPhone.trimmingCharacters(in: .whitespaces)
        guard phone.filter(\.isNumber).count >= 7 else {
            whatsappEnroll = .failed("Enter a valid phone number.")
            return
        }
        whatsappEnroll = .enrolling
        do {
            _ = try await api.enrollWhatsApp(phone: phone)
            whatsappEnroll = .sent
        } catch {
            whatsappEnroll = .failed("Couldn't connect WhatsApp. Please try again.")
        }
    }

    /// Turn the WhatsApp channel off and unlink the number.
    func disconnectWhatsApp() {
        whatsappEnroll = .idle
        Task { _ = try? await api.disableWhatsApp() }
    }
}
