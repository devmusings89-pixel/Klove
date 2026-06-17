import Foundation

/// Medication schedules, dose logging, and adherence.
extension APIClient {
    func memberMedications(_ memberId: String) async throws -> [MemberMedication] {
        let response: MedicationsResponse = try await get("/members/\(memberId)/medications")
        return response.medications
    }

    /// Manually add a medication for a member (sourceType "manual" server-side).
    func addMedication(_ memberId: String, _ med: MedicationBody) async throws -> CreatedMedication {
        try await post("/members/\(memberId)/medications", body: med)
    }

    /// Edit an existing medication (works on extracted meds too, to correct them).
    func updateMedication(_ medId: String, _ med: MedicationBody) async throws -> CreatedMedication {
        try await patch("/medications/\(medId)", body: med)
    }

    /// Drug-name autocomplete suggestions (matched against RxNav's curated display-name list).
    func searchDrugs(_ q: String) async throws -> [DrugSuggestion] {
        let trimmed = q.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else { return [] }
        let r: DrugSearchResponse = try await getQuery("/medications/search", query: ["q": trimmed])
        return r.results
    }

    /// Resolve a picked suggestion's canonical name to its RxNorm code (nil if no exact match).
    func resolveDrugRxcui(_ term: String) async -> String? {
        let r: RxcuiResponse? = try? await getQuery("/medications/rxcui", query: ["name": term])
        return r?.rxcui
    }

    /// GET with query params. appendingPathComponent (used by the shared `get`) would percent-encode
    /// the "?", so build the URL with URLComponents instead.
    private func getQuery<R: Decodable>(_ path: String, query: [String: String]) async throws -> R {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        comps?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = comps?.url else { throw AppError.server(status: -1, message: "bad url") }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        return try await send(req)
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
