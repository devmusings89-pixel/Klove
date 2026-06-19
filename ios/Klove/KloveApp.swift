import SwiftUI

@main
struct KloveApp: App {
    @AppStorage(AppStorageKey.hasOnboarded) private var hasOnboarded = false
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @State private var invites = InviteCoordinator.shared
    @State private var auth = AuthService.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if !hasOnboarded {
                    OnboardingView()
                        .transition(.opacity)
                } else if auth.isAuthenticated {
                    MainTabView()
                } else {
                    // Onboarded but no valid session (no/expired Supabase token). The production
                    // backend requires a real JWT, so re-authenticate before loading data — otherwise
                    // every request 401s and the app misreports it as "Couldn't reach Klove".
                    ReAuthView()
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
