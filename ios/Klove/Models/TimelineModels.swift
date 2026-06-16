import Foundation

/// One entry in a member's clean chronological health story (mirrors backend graph.ts TimelineEntry).
struct TimelineEntry: Decodable, Identifiable, Hashable {
    let id: String
    let kind: String          // observation | condition | medication | report | allergy | appointment
    let date: String?         // ISO
    let title: String
    let detail: String?
    let source: String
    let abnormal: Bool?

    var symbol: String {
        switch kind {
        case "observation": return "waveform.path.ecg"
        case "condition": return "stethoscope"
        case "medication": return "pills.fill"
        case "report": return "doc.text.fill"
        case "allergy": return "exclamationmark.triangle.fill"
        case "appointment": return "calendar"
        default: return "circle.fill"
        }
    }

    /// Short human date (e.g. "Jun 2026") from the ISO string.
    var displayDate: String {
        guard let date, let parsed = ISO8601DateFormatter().date(from: date) else { return "—" }
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy"
        return f.string(from: parsed)
    }
}

/// Compact grounded snapshot of a member's care (mirrors backend graph.ts GraphSummary).
struct MemberSummary: Decodable {
    struct Counts: Decodable { let conditions, medications, observations, appointments, allergies: Int }
    struct NextAppt: Decodable { let title: String; let date: String?; let provider: String? }
    let counts: Counts
    let activeConditions: [String]
    let activeMedications: [String]
    let nextAppointment: NextAppt?
}
