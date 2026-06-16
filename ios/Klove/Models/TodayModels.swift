import Foundation

/// A task in the Today briefing / Actions log (mirrors backend Task + memberName).
struct KloveTask: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String?
    let kind: String            // review | book | prep | follow_up | reminder
    let state: String           // needs_you | waiting | handled
    let memberName: String?
    let subjectUserId: String?
    let conciergeJobId: String?
    let options: [String]?

    var isChooseTime: Bool { kind == "choose_time" }

    var kindSymbol: String {
        switch kind {
        case "book": return "phone.bubble.fill"
        case "prep": return "list.clipboard.fill"
        case "follow_up": return "arrow.uturn.forward"
        case "reminder": return "bell.fill"
        case "choose_time": return "clock.badge.questionmark"
        default: return "checkmark.circle"
        }
    }
}

struct UpcomingAppt: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let provider: String?
    let startsAt: String?
    let memberName: String?
}

struct MemberRef: Decodable, Hashable { let id: String; let name: String }

/// The Today briefing payload (GET /today).
struct TodayBriefing: Decodable {
    let needsYou: [KloveTask]
    let waiting: [KloveTask]
    let handled: [KloveTask]
    let upcomingAppointments: [UpcomingAppt]
    let members: [MemberRef]
}

/// A notification/message in the inbox (GET /notifications).
struct KloveNotification: Decodable, Identifiable, Hashable {
    let id: String
    let title: String?
    let body: String
    let readAt: String?
    let createdAt: String?
}

struct NotificationsResponse: Decodable {
    let unread: Int
    let messages: [KloveNotification]
}
