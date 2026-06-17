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
    var adherence7d: MedAdherence? = nil
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

/// 7-day taken/missed counts for a single medication.
struct MedAdherence: Decodable, Hashable {
    let taken: Int
    let missed: Int
}

struct Dose: Decodable, Identifiable, Hashable {
    let id: String
    let scheduledAt: String
    let status: String    // pending | taken | missed | skipped
    let takenAt: String?
    var timeLabel: String? = nil   // pre-formatted in the MEMBER's timezone by the backend

    /// Prefer the server's member-timezone label; fall back to local formatting if absent.
    var timeDisplay: String {
        if let l = timeLabel, !l.isEmpty { return l }
        guard let d = ISO8601.parse(scheduledAt) else { return "" }
        let f = DateFormatter(); f.dateFormat = "h:mm a"
        return f.string(from: d)
    }
}

/// GET /members/:id/medications — medications plus the member's timezone (dose times are already
/// formatted in that zone server-side).
struct MedicationsResponse: Decodable {
    let timezone: String
    let medications: [MemberMedication]
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
