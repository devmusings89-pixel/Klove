import Foundation

/// Per-member health data endpoints (Phase 2): timeline, summary, records, sources, uploads.
/// All are consent-gated server-side via `resolveSubject`.
extension APIClient {
    func memberTimeline(_ memberId: String) async throws -> [TimelineEntry] {
        try await get("/members/\(memberId)/timeline")
    }

    func memberSummary(_ memberId: String) async throws -> MemberSummary {
        try await get("/members/\(memberId)/summary")
    }

    func memberRecords(_ memberId: String) async throws -> HealthRecords {
        try await get("/members/\(memberId)/health-records")
    }

    func memberSources(_ memberId: String) async throws -> [SourceConnection] {
        try await get("/members/\(memberId)/sources")
    }

    func connectMemberSource(_ memberId: String, type: SourceType, params: [String: String] = [:]) async throws -> ConnectResponse {
        try await post("/members/\(memberId)/sources/\(type.rawValue)/connect", body: params)
    }

    /// Connect/scan email for medical records. Live → returns OAuth redirectUrl; mock → scans samples.
    func connectMemberEmail(_ memberId: String) async throws -> EmailScanResponse {
        try await post("/members/\(memberId)/sources/email/connect", body: [String: String]())
    }

    @discardableResult
    func disconnectMemberSource(_ memberId: String, type: SourceType) async throws -> EmptyResponse {
        try await post("/members/\(memberId)/sources/\(type.rawValue)/disconnect", body: [String: String]())
    }

    @discardableResult
    func syncMemberHealthKit(_ memberId: String, resources: [String]) async throws -> EmptyResponse {
        try await post("/members/\(memberId)/sources/healthkit/sync", body: ["resources": resources])
    }

    /// Upload a document assigned to a specific member (multipart).
    func uploadForMember(_ memberId: String, data: Data, mimeType: String, filename: String) async throws -> UploadResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: baseURL.appendingPathComponent("/members/\(memberId)/uploads"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
        body.append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n")
        req.httpBody = body
        return try await send(req)
    }
}

/// Result of an email connect/scan. `mode` is "live" (open redirectUrl) or "mock" (scanned now).
struct EmailScanResponse: Decodable {
    let mode: String
    let redirectUrl: String?
    let scanned: Int?
}
