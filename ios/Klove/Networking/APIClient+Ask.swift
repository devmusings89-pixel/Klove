import Foundation

/// Ask Klove (triage) + Show Me (focused views) + device registration (Phase 5).
struct AskResult: Decodable {
    let kind: String        // answer | escalated
    let answer: String
    let routedTo: String    // ai | concierge
    /// Grounding sources behind the answer (titles), when the backend provides them.
    let sources: [String]?
    /// Structured cards the agent wants shown inline (physician lists, booking recap, …).
    let cards: [AgentCard]?
    /// Set when the agent is awaiting confirmation for a state-changing action.
    let proposal: AskProposal?
}

/// The agent's pending state-changing action, awaiting a Confirm tap.
struct AskProposal: Decodable, Hashable {
    let restatement: String
    let tool: String
}

/// A recap of a proposed booking (shown with Confirm / Edit).
struct BookingRecap: Decodable, Hashable {
    let reason: String
    let provider: String?
    let memberName: String
    let phone: String?
    let website: String?
    let preferredTimes: String?
    let insurance: String?
}

/// A structured payload the chat renders inline. Mirrors the backend `AgentCard` union.
enum AgentCard: Decodable {
    case physicianList(resolvedSpecialty: String?, memberInsurance: [String], results: [PhysicianResult])
    case bookingRecap(BookingRecap)
    case prepList(title: String, questions: [String])
    case text(String)
    case unknown

    private enum K: String, CodingKey { case type, resolvedSpecialty, memberInsurance, results, recap, title, questions, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decodeIfPresent(String.self, forKey: .type) ?? "" {
        case "physician_list":
            self = .physicianList(
                resolvedSpecialty: try c.decodeIfPresent(String.self, forKey: .resolvedSpecialty),
                memberInsurance: try c.decodeIfPresent([String].self, forKey: .memberInsurance) ?? [],
                results: try c.decodeIfPresent([PhysicianResult].self, forKey: .results) ?? []
            )
        case "booking_recap":
            self = .bookingRecap(try c.decode(BookingRecap.self, forKey: .recap))
        case "prep_list":
            self = .prepList(title: try c.decodeIfPresent(String.self, forKey: .title) ?? "",
                             questions: try c.decodeIfPresent([String].self, forKey: .questions) ?? [])
        case "text":
            self = .text(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        default:
            self = .unknown
        }
    }
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

    /// Confirm the agent's pending proposal (the Confirm button on a card).
    func confirmAsk() async throws -> AskResult {
        try await post("/ask/confirm", body: [String: String]())
    }

    /// Dismiss the agent's pending proposal (Edit / cancel).
    @discardableResult
    func cancelAsk() async throws -> EmptyResponse {
        try await post("/ask/cancel", body: [String: String]())
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
