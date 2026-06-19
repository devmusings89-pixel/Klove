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

    /// Resolve an office by name so the booking form can confirm "found it" before booking.
    func lookupOffice(_ query: String) async throws -> OfficeMatch? {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let r: OfficeLookupResponse = try await get("/lookup/office?q=\(q)")
        return r.match
    }

    /// Step 1 of booking: resolve the provider (known-provider directory → Places) and the patient's
    /// details, and get a recap to CONFIRM. No calls are placed. status "ready" → show recap + confirm;
    /// "needs_provider" → let the operator pick from `candidates` or add a new provider, then prepare again.
    func prepareBooking(_ memberId: String, reason: String, provider: String? = nil, specialty: String? = nil, preferredTimes: String? = nil, phone: String? = nil, website: String? = nil, insurancePlanId: String? = nil) async throws -> BookingPlan {
        try await post("/members/\(memberId)/book/prepare", body: BookBody(reason: reason, provider: provider, specialty: specialty, preferredDate: nil, preferredTimes: preferredTimes, phone: phone, website: website, insurancePlanId: insurancePlanId))
    }

    /// Step 2: place the booking the operator confirmed (originated in the app).
    @discardableResult
    func bookForMember(_ memberId: String, reason: String, provider: String?, specialty: String? = nil, preferredDate: String? = nil, preferredTimes: String? = nil, phone: String? = nil, website: String? = nil, insurancePlanId: String? = nil) async throws -> BookingOutcome {
        try await post("/members/\(memberId)/book", body: BookBody(reason: reason, provider: provider, specialty: specialty, preferredDate: preferredDate, preferredTimes: preferredTimes, phone: phone, website: website, insurancePlanId: insurancePlanId))
    }

    @discardableResult
    func submitVisitSummary(_ memberId: String, appointmentId: String, summary: String, followUps: [String]) async throws -> EmptyResponse {
        try await post("/members/\(memberId)/appointments/\(appointmentId)/summary", body: VisitSummaryBody(summary: summary, followUps: followUps))
    }

    @discardableResult
    func rescheduleAppointment(_ memberId: String, appointmentId: String, startsAt: String) async throws -> EmptyResponse {
        try await patch("/members/\(memberId)/appointments/\(appointmentId)", body: ["startsAt": startsAt])
    }

    @discardableResult
    func cancelAppointment(_ memberId: String, appointmentId: String) async throws -> EmptyResponse {
        try await patch("/members/\(memberId)/appointments/\(appointmentId)", body: ["status": "cancelled"])
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
    let sessionId: String?
    let verified: Bool?
    /// Echoed by the backend: who this was booked for and which coverage was attached.
    let patientName: String?
    let insurance: String?

    var isConfirmed: Bool { status == "confirmed" }
    /// A confirmed booking that Klove placed WITHOUT a live call — a hold, not an office confirmation.
    var isProvisional: Bool { status == "confirmed" && verified == false }
    /// A live booking still in flight — Klove is contacting the office; nothing is confirmed yet.
    var isInProgress: Bool { status == "in_progress" }

    var whenDisplay: String {
        guard let s = startsAt, let d = ISO8601.parse(s) else { return "soon" }
        let f = DateFormatter(); f.dateFormat = "MMM d 'at' h:mm a zzz"
        return f.string(from: d)
    }
}

/// Tolerant ISO8601 parsing. The backend always emits fractional seconds (`.SSSZ`, see
/// backend/src/routes/prep.ts), which `ISO8601DateFormatter` rejects by default — so booked times
/// were rendering as "soon". Try with fractional seconds first, then fall back to plain ISO8601.
enum ISO8601 {
    static func parse(_ s: String) -> Date? {
        // Built locally (not cached statics) so this stays Sendable-clean under Swift 6 strict
        // concurrency; ISO8601DateFormatter isn't Sendable. Cheap enough for our call volume.
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: s) { return d }
        return ISO8601DateFormatter().date(from: s)
    }
}

/// An office resolved from a name via Google Places (GET /lookup/office).
struct OfficeMatch: Decodable, Hashable {
    let displayName: String
    let phone: String?
    let website: String?
    let address: String?
}
private struct OfficeLookupResponse: Decodable { let match: OfficeMatch? }

private struct BookBody: Encodable {
    let reason: String
    let provider: String?
    let specialty: String?
    let preferredDate: String?
    let preferredTimes: String?
    let phone: String?
    let website: String?
    let insurancePlanId: String?
}

/// Recap returned by POST /members/:id/book/prepare — the operator confirms this before any calls.
struct BookingPlan: Decodable {
    let status: String          // "ready" | "needs_provider"
    let reason: String
    let provider: PlanProvider?
    let candidates: [PlanProvider]
    let missing: [String]
    let patientName: String
    let insuranceLabel: String
    let preferredTimes: String
    let recap: String

    var isReady: Bool { status == "ready" }
}

/// A provider resolved for / offered by the booking flow (from the directory, Places, or explicit input).
struct PlanProvider: Decodable, Hashable, Identifiable {
    let providerId: String?
    let name: String
    let phone: String?
    let website: String?
    let address: String?
    let specialty: String?
    let source: String

    enum CodingKeys: String, CodingKey { case providerId = "id", name, phone, website, address, specialty, source }
    var id: String { providerId ?? name }
}
private struct VisitSummaryBody: Encodable { let summary: String; let followUps: [String] }
