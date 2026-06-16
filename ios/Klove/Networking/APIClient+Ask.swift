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
    let series: ShowMeSeries?
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
    func registerDevice(token: String) async throws -> EmptyResponse {
        try await post("/devices/token", body: ["token": token])
    }
}
