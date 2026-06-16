import Foundation

@MainActor
@Observable
final class OnboardingModel {
    /// Ordered onboarding steps.
    enum Step: Int, CaseIterable {
        case welcome, value, identify, connect

        var isLast: Bool { self == Step.allCases.last }
    }

    var step: Step = .welcome
    var email: String = UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? ""
    var identifyError: String?

    /// Source connection is shared with Settings via SourcesModel.
    let sources = SourcesModel()

    // MARK: - Navigation

    func advance() {
        if step == .identify, !saveIdentity() { return }
        if let next = Step(rawValue: step.rawValue + 1) {
            step = next
            if step == .connect { Task { await sources.loadSources() } }
        }
    }

    func back() {
        if let prev = Step(rawValue: step.rawValue - 1) { step = prev }
    }

    // MARK: - Identity (mock-mode; replaced by Sign in with Apple later)

    private func saveIdentity() -> Bool {
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
