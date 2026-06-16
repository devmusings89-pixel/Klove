import Foundation

/// Appointment-prep hero flow (Phase 4): brief, questions, authorize, booking handoff, summary.
extension APIClient {
    func getPrep(_ memberId: String, appointmentId: String? = nil) async throws -> AppointmentBrief {
        let q = appointmentId.map { "?appointmentId=\($0)" } ?? ""
        return try await get("/members/\(memberId)/prep\(q)")
    }

    @discardableResult
    func saveQuestions(_ memberId: String, appointmentId: String, questions: [String]) async throws -> EmptyResponse {
        try await patch("/members/\(memberId)/appointments/\(appointmentId)/questions", body: ["questions": questions])
    }

    @discardableResult
    func authorizeBooking(_ memberId: String) async throws -> EmptyResponse {
        try await post("/members/\(memberId)/authorize-booking", body: [String: String]())
    }

    @discardableResult
    func bookForMember(_ memberId: String, reason: String, provider: String?, preferredDate: String? = nil, preferredTimes: String? = nil, phone: String? = nil, website: String? = nil) async throws -> BookingOutcome {
        try await post("/members/\(memberId)/book", body: BookBody(reason: reason, provider: provider, preferredDate: preferredDate, preferredTimes: preferredTimes, phone: phone, website: website))
    }

    @discardableResult
    func submitVisitSummary(_ memberId: String, appointmentId: String, summary: String, followUps: [String]) async throws -> EmptyResponse {
        try await post("/members/\(memberId)/appointments/\(appointmentId)/summary", body: VisitSummaryBody(summary: summary, followUps: followUps))
    }
}

/// Result of a concierge booking (POST /members/:id/book). `status` is "confirmed" (simulated /
/// instant) or "in_progress" (live — Klove is contacting the office; confirmation arrives later).
struct BookingOutcome: Decodable {
    let status: String
    let title: String
    let provider: String?
    let taskId: String
    let appointmentId: String?
    let confirmation: String?
    let startsAt: String?

    var isConfirmed: Bool { status == "confirmed" }

    var whenDisplay: String {
        guard let s = startsAt, let d = ISO8601DateFormatter().date(from: s) else { return "soon" }
        let f = DateFormatter(); f.dateFormat = "MMM d 'at' h:mm a"
        return f.string(from: d)
    }
}

private struct BookBody: Encodable {
    let reason: String
    let provider: String?
    let preferredDate: String?
    let preferredTimes: String?
    let phone: String?
    let website: String?
}
private struct VisitSummaryBody: Encodable { let summary: String; let followUps: [String] }
