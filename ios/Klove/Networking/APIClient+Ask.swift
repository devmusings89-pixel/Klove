import Foundation

/// Ask Klove (triage) + Show Me (focused views) + device registration (Phase 5).
struct AskResult: Decodable {
    let kind: String        // answer | escalated
    let answer: String
    let routedTo: String    // ai | concierge
}

struct ShowMeResult: Decodable {
    let title: String
    let count: Int
    let entries: [TimelineEntry]
}

extension APIClient {
    func ask(_ text: String) async throws -> AskResult {
        try await post("/ask", body: ["text": text])
    }

    func showMe(_ memberId: String, query: String) async throws -> ShowMeResult {
        try await post("/members/\(memberId)/show-me", body: ["query": query])
    }

    @discardableResult
    func registerDevice(token: String) async throws -> EmptyResponse {
        try await post("/devices/token", body: ["token": token])
    }
}
