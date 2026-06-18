import Foundation

/// Ask Klove (triage) + Show Me (focused views) + device registration (Phase 5).
struct AskResult: Decodable {
    let kind: String        // answer | escalated
    let answer: String
    let routedTo: String    // ai | concierge
    /// Grounding sources behind the answer (titles), when the backend provides them.
    let sources: [String]?
}

struct ShowMeResult: Decodable {
    let title: String
    let count: Int
    let entries: [TimelineEntry]
    let series: ShowMeSeries?
    /// Plain-language, grounded answer ("what changed and why it matters"). Nil when no LLM/records.
    let summary: String?
}

/// Result of linking a WhatsApp number — `verificationSent` is true once the "reply YES" prompt went out.
struct WhatsAppEnrollResult: Decodable {
    let ok: Bool
    let verificationSent: Bool
}

/// Current WhatsApp link status returned by GET /whatsapp/enroll.
struct WhatsAppStatus: Decodable {
    let phone: String?
    let verified: Bool
    let enabled: Bool
}

/// A numeric trend for charting (e.g. blood pressure over time).
struct ShowMeSeries: Decodable {
    let display: String
    let unit: String?
    let points: [Point]

    struct Point: Decodable, Identifiable {
        let date: String
        let value: Double
        var id: String { date }
        var parsedDate: Date { ISO8601DateFormatter().date(from: date) ?? Date() }
    }
}

extension APIClient {
    func ask(_ text: String) async throws -> AskResult {
        try await post("/ask", body: ["text": text])
    }

    func showMe(_ memberId: String, query: String) async throws -> ShowMeResult {
        try await post("/members/\(memberId)/show-me", body: ["query": query])
    }

    @discardableResult
    func addToBrief(_ memberId: String, title: String, detail: String?) async throws -> EmptyResponse {
        try await post("/members/\(memberId)/brief", body: ["title": title, "detail": detail ?? ""])
    }

    /// Link a WhatsApp number to the account. The backend stores it and sends a "reply YES to connect"
    /// message; the inbound webhook verifies it, after which the WhatsApp concierge agent takes over.
    @discardableResult
    func getWhatsAppStatus() async throws -> WhatsAppStatus {
        try await get("/whatsapp/enroll")
    }

    func enrollWhatsApp(phone: String) async throws -> WhatsAppEnrollResult {
        try await post("/whatsapp/enroll", body: ["phone": phone])
    }

    /// Unlink the WhatsApp number / turn the channel off.
    @discardableResult
    func disableWhatsApp() async throws -> EmptyResponse {
        try await delete("/whatsapp/enroll")
    }

    @discardableResult
    func registerDevice(token: String) async throws -> EmptyResponse {
        // Send the device timezone so medication doses are scheduled in the user's local time.
        try await post("/devices/token", body: ["token": token, "timezone": TimeZone.current.identifier])
    }
}
