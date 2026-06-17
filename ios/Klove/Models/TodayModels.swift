import Foundation

/// Structured booking confirmation attached to a booking task (mirrors backend Task.bookingJson).
struct BookingInfo: Decodable, Hashable {
    let when: String?          // ISO date-time, or null when only free-text is known
    let whenText: String?      // human label the backend produced
    let provider: String?
    let confirmation: String?
    let verified: Bool         // true = office-confirmed; false = provisional hold

    /// Polished, locale-aware "Thu, Jun 19 · 11:02 PM"; falls back to the backend's text.
    var whenDisplay: String {
        if let s = when, let d = ISO8601DateFormatter().date(from: s) {
            let f = DateFormatter(); f.dateFormat = "EEE, MMM d · h:mm a"
            return f.string(from: d)
        }
        return whenText ?? "Time to be confirmed"
    }
}

/// Structured care follow-up attached to a health-insight task (mirrors backend Task.followUpJson).
struct FollowUpInfo: Decodable, Hashable {
    let followUpType: String?      // book_visit | retest | refill | referral | vaccine | med_review
    let recommendedSpecialty: String?
    let daysToAction: Int?
    let guideline: String?

    /// Human verb for the recommended action.
    var actionLabel: String {
        switch followUpType {
        case "book_visit": return "Book a visit"
        case "retest": return "Re-test"
        case "refill": return "Refill"
        case "referral": return "Get a referral"
        case "vaccine": return "Get vaccinated"
        case "med_review": return "Review medications"
        default: return "Follow up"
        }
    }
    var icon: String {
        switch followUpType {
        case "book_visit", "referral": return "calendar.badge.plus"
        case "retest": return "arrow.clockwise"
        case "refill": return "pills.fill"
        case "vaccine": return "syringe.fill"
        case "med_review": return "checklist"
        default: return "arrow.uturn.forward"
        }
    }
}

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
    let booking: BookingInfo?
    let followUp: FollowUpInfo?

    var isChooseTime: Bool { kind == "choose_time" }
    var isBooking: Bool { booking != nil }

    /// Title without the internal "Booking:/Hold:" prefix (status is shown separately on the card).
    var displayTitle: String {
        title.replacingOccurrences(of: #"^(Booking|Hold):\s*"#, with: "", options: .regularExpression)
    }

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
    let subjectUserId: String?
    let memberName: String?
    var verified: Bool? = nil
    var confirmation: String? = nil

    /// A provisional hold Klove placed without a live office confirmation.
    var isProvisional: Bool { verified == false }

    var whenDisplay: String {
        guard let s = startsAt, let d = ISO8601DateFormatter().date(from: s) else { return "Time TBD" }
        let f = DateFormatter(); f.dateFormat = "EEE, MMM d 'at' h:mm a zzz"
        return f.string(from: d)
    }
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
