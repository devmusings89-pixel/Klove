import UIKit
import UserNotifications

extension Notification.Name {
    /// Posted when the user taps a push that carries a `link` deep-link hint (e.g. "actions"/"today").
    /// MainTabView observes this to switch tabs. userInfo carries `["tab": <name>]`.
    static let kloveDeepLink = Notification.Name("kloveDeepLink")
}

/// Remote push (APNs) registration. `PushManager.register()` asks permission and registers; the
/// app delegate receives the device token and POSTs it to the backend (`/devices/token`) so Klove
/// can reach the operator with reminders, "booked", and "choose a time" pushes.
enum PushManager {
    /// Ask for notification permission and register for remote notifications. Call after sign-in.
    static func register() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }
}

/// App delegate wired via `@UIApplicationDelegateAdaptor` in KloveApp — handles the APNs token
/// callback and foreground notification presentation.
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { try? await APIClient().registerDevice(token: hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("APNs registration failed: \(error.localizedDescription)")
    }

    /// Show pushes while the app is foregrounded (so reminders/booked confirmations aren't silent).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    /// The user tapped a notification. If it carries a `link` deep-link hint, broadcast it so the
    /// root tab view can navigate to the relevant place (Actions for needs-you, Today for booked).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let link = response.notification.request.content.userInfo["link"] as? String {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .kloveDeepLink, object: nil, userInfo: ["tab": link])
            }
        }
        completionHandler()
    }
}
