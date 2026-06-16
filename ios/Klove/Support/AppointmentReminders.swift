import Foundation
import UserNotifications

/// Schedules a local reminder one day before each upcoming appointment.
/// Re-scheduling is idempotent: pending appointment reminders are cleared and rebuilt each call.
enum AppointmentReminders {
    static func sync(_ appointments: [Appointment]) async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return }

        let pending = await center.pendingNotificationRequests()
        let stale = pending.map(\.identifier).filter { $0.hasPrefix("appt-") }
        center.removePendingNotificationRequests(withIdentifiers: stale)

        for appt in appointments {
            guard let startsAt = HealthFormat.parseDate(appt.startsAt), startsAt > Date() else { continue }
            let remindAt = startsAt.addingTimeInterval(-86_400) // 1 day before
            guard remindAt > Date() else { continue }

            let content = UNMutableNotificationContent()
            content.title = "Upcoming appointment"
            content.body = "\(appt.title) tomorrow" + (appt.provider.map { " — \($0)" } ?? "")
            content.sound = .default

            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: remindAt)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            let request = UNNotificationRequest(identifier: "appt-\(appt.id)", content: content, trigger: trigger)
            try? await center.add(request)
        }
    }
}
