import Foundation

/// Today briefing, tasks, and notifications (Phase 3).
extension APIClient {
    func getToday() async throws -> TodayBriefing {
        try await get("/today")
    }

    func getTasks() async throws -> [KloveTask] {
        try await get("/tasks")
    }

    @discardableResult
    func updateTask(_ id: String, state: String) async throws -> KloveTask {
        try await patch("/tasks/\(id)", body: ["state": state])
    }

    @discardableResult
    func routeTaskToConcierge(_ id: String) async throws -> KloveTask {
        try await post("/tasks/\(id)/route-to-concierge", body: [String: String]())
    }

    /// Pick one of the alternate times the office offered for a choose_time task.
    @discardableResult
    func chooseTaskSlot(_ id: String, slot: String) async throws -> EmptyResponse {
        try await post("/tasks/\(id)/choose", body: ["slot": slot])
    }

    func getNotifications() async throws -> NotificationsResponse {
        try await get("/notifications")
    }

    @discardableResult
    func markNotificationRead(_ id: String) async throws -> EmptyResponse {
        try await post("/notifications/\(id)/read", body: [String: String]())
    }
}
