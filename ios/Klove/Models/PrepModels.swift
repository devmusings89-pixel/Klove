import Foundation

/// The one-page appointment brief (GET /members/:id/prep).
struct AppointmentBrief: Decodable {
    struct ApptRef: Decodable, Hashable {
        let id: String?
        let title: String
        let provider: String?
        let startsAt: String?
    }
    let appointment: ApptRef?
    let summary: MemberSummary
    let recentEvents: [TimelineEntry]
    let questions: [String]
}
