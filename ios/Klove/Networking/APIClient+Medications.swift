import Foundation

/// Medication schedules, dose logging, and adherence.
extension APIClient {
    func memberMedications(_ memberId: String) async throws -> [MemberMedication] {
        try await get("/members/\(memberId)/medications")
    }

    func setMedicationSchedule(_ medId: String, times: [String], critical: Bool) async throws -> MedSchedule {
        try await post("/medications/\(medId)/schedule", body: ScheduleBody(times: times, critical: critical))
    }

    func clearMedicationSchedule(_ medId: String) async throws -> EmptyResponse {
        try await delete("/medications/\(medId)/schedule")
    }

    /// Change a dose's status: "taken" | "skipped" | "pending" (the last undoes a mistaken tap).
    func setDoseStatus(_ doseId: String, status: String) async throws -> Dose {
        try await post("/doses/\(doseId)/status", body: ["status": status])
    }

    func memberAdherence(_ memberId: String) async throws -> Adherence {
        try await get("/members/\(memberId)/adherence")
    }
}

private struct ScheduleBody: Encodable {
    let times: [String]
    let critical: Bool
}
