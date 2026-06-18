import SwiftUI

@main
struct KloveApp: App {
    @AppStorage(AppStorageKey.hasOnboarded) private var hasOnboarded = false
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @State private var invites = InviteCoordinator.shared

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
            .onOpenURL { url in
                // Auth callbacks (magic link / OAuth) complete a session; everything else is an invite.
                if AuthService.shared.completeMagicLink(from: url) { return }
                invites.handle(url)
            }
            .sheet(item: $invites.pending) { invite in
                AcceptInviteView(token: invite.token)
            }
        }
    }
}
