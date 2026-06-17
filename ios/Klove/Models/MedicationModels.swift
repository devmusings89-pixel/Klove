import Foundation

/// A medication for a member, with its dosing schedule and today's dose statuses (GET /members/:id/medications).
struct MemberMedication: Decodable, Identifiable, Hashable {
    let id: String
    let display: String
    let dosage: String?
    let status: String?
    let nextRefillDue: String?
    let refillsRemaining: Int?
    let schedule: MedSchedule?
    let todaysDoses: [Dose]

    var refillDisplay: String? {
        guard let s = nextRefillDue, let d = ISO8601.parse(s) else { return nil }
        let f = DateFormatter(); f.dateFormat = "MMM d"
        return f.string(from: d)
    }
}

struct MedSchedule: Decodable, Hashable {
    let id: String
    let times: [String]   // "HH:MM" 24h
    let active: Bool
    let critical: Bool
}

struct Dose: Decodable, Identifiable, Hashable {
    let id: String
    let scheduledAt: String
    let status: String    // pending | taken | missed | skipped
    let takenAt: String?

    var timeDisplay: String {
        guard let d = ISO8601.parse(scheduledAt) else { return "" }
        let f = DateFormatter(); f.dateFormat = "h:mm a"
        return f.string(from: d)
    }
}

/// 7-day adherence summary (GET /members/:id/adherence).
struct Adherence: Decodable, Hashable {
    let windowDays: Int
    let total: Int
    let taken: Int
    let missed: Int
    let pending: Int
    let adherenceRate: Double?

    var ratePercent: String? {
        guard let r = adherenceRate else { return nil }
        return "\(Int((r * 100).rounded()))%"
    }
}
