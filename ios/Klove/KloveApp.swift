import SwiftUI

@main
struct KloveApp: App {
    @AppStorage(AppStorageKey.hasOnboarded) private var hasOnboarded = false

    var body: some Scene {
        WindowGroup {
            Group {
                if hasOnboarded {
                    MainTabView()
                } else {
                    OnboardingView()
                        .transition(.opacity)
                }
            }
            // Warm Klove accent everywhere (onboarding, sheets, alerts) — never health-app blue.
            .tint(Theme.accent)
        }
    }
}
