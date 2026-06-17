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

    /// Snooze a task — hides it from Today for `days`, then it resurfaces.
    @discardableResult
    func snoozeTask(_ id: String, days: Int) async throws -> KloveTask {
        try await post("/tasks/\(id)/snooze", body: ["days": days])
    }

    /// Pick one of the alternate times the office offered for a choose_time task.
    @discardableResult
    func chooseTaskSlot(_ id: String, slot: String) async throws -> EmptyResponse {
        try await post("/tasks/\(id)/choose", body: ["slot": slot])
    }

    /// Dismiss/delete a task.
    @discardableResult
    func deleteTask(_ id: String) async throws -> EmptyResponse {
        try await delete("/tasks/\(id)")
    }

    func getPreferences() async throws -> Preferences {
        try await get("/preferences")
    }

    @discardableResult
    func updatePreferences(pushEnabled: Bool, reminderLeadHours: Int) async throws -> Preferences {
        try await patch("/preferences", body: PreferencesBody(pushEnabled: pushEnabled, reminderLeadHours: reminderLeadHours))
    }

    /// Remove a wrong record from a member's timeline (correction).
    @discardableResult
    func deleteRecord(_ memberId: String, kind: String, recordId: String) async throws -> EmptyResponse {
        try await delete("/members/\(memberId)/records/\(kind)/\(recordId)")
    }
}

struct Preferences: Decodable { let pushEnabled: Bool; let reminderLeadHours: Int }
private struct PreferencesBody: Encodable { let pushEnabled: Bool; let reminderLeadHours: Int }

extension APIClient {
    func getNotifications() async throws -> NotificationsResponse {
        try await get("/notifications")
    }

    @discardableResult
    func markNotificationRead(_ id: String) async throws -> EmptyResponse {
        try await post("/notifications/\(id)/read", body: [String: String]())
    }
}
