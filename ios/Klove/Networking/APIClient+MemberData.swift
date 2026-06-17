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

    // MARK: - Per-member profile + insurance wallet

    /// A member's profile (demographics + insurance wallet). Operator-managed members included.
    func memberProfile(_ memberId: String) async throws -> UserProfile? {
        let r: ProfileResponse = try await get("/members/\(memberId)/profile")
        return r.profile
    }

    @discardableResult
    func putMemberProfile(_ memberId: String, fullName: String, dob: String?, phone: String?, email: String?, address: String?) async throws -> UserProfile? {
        let r: ProfileResponse = try await put("/members/\(memberId)/profile", body: MemberProfileBody(fullName: fullName, dob: dob, phone: phone, email: email, address: address))
        return r.profile
    }

    /// List a member's insurance cards (wallet).
    func memberInsurance(_ memberId: String) async throws -> [InsuranceCard] {
        let r: InsuranceWalletResponse = try await get("/members/\(memberId)/insurance")
        return r.plans
    }

    /// Add a card to a member's wallet. Pass `makePrimary`/`makeBackup` to claim the single
    /// primary/backup slot (otherwise the first card added becomes primary by default).
    @discardableResult
    func addMemberInsurance(_ memberId: String, _ info: InsuranceInfo, makePrimary: Bool = false, makeBackup: Bool = false) async throws -> [InsuranceCard] {
        let r: InsuranceWalletResponse = try await post("/members/\(memberId)/insurance", body: InsuranceWriteBody(info: info, isPrimary: makePrimary, isSecondary: makeBackup))
        return r.plans
    }

    /// Update an existing card in a member's wallet. Pass `makePrimary`/`makeBackup` to re-point the
    /// single primary/backup slot (a card is at most one of the two; primary wins if both are set).
    @discardableResult
    func updateMemberInsurance(_ memberId: String, planId: String, _ info: InsuranceInfo, makePrimary: Bool = false, makeBackup: Bool = false) async throws -> [InsuranceCard] {
        let r: InsuranceWalletResponse = try await patch("/members/\(memberId)/insurance/\(planId)", body: InsuranceWriteBody(info: info, isPrimary: makePrimary, isSecondary: makeBackup))
        return r.plans
    }

    /// Remove a card from a member's wallet.
    @discardableResult
    func deleteMemberInsurance(_ memberId: String, planId: String) async throws -> [InsuranceCard] {
        let r: InsuranceWalletResponse = try await delete("/members/\(memberId)/insurance/\(planId)")
        return r.plans
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

private struct MemberProfileBody: Encodable {
    let fullName: String
    let dob: String?
    let phone: String?
    let email: String?
    let address: String?
}

/// Body for adding/updating a wallet card — the card fields plus an explicit primary/backup re-point.
private struct InsuranceWriteBody: Encodable {
    let info: InsuranceInfo
    let isPrimary: Bool
    let isSecondary: Bool

    enum CodingKeys: String, CodingKey {
        case carrier, planName, memberId, groupId, rxBin, rxPcn, holderName, isPrimary, isSecondary
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(info.carrier, forKey: .carrier)
        try c.encodeIfPresent(info.planName, forKey: .planName)
        try c.encodeIfPresent(info.memberId, forKey: .memberId)
        try c.encodeIfPresent(info.groupId, forKey: .groupId)
        try c.encodeIfPresent(info.rxBin, forKey: .rxBin)
        try c.encodeIfPresent(info.rxPcn, forKey: .rxPcn)
        try c.encodeIfPresent(info.holderName, forKey: .holderName)
        try c.encode(isPrimary, forKey: .isPrimary)
        try c.encode(isSecondary, forKey: .isSecondary)
    }
}

/// Result of an email connect/scan. `mode` is "live" (open redirectUrl) or "mock" (scanned now).
struct EmailScanResponse: Decodable {
    let mode: String
    let redirectUrl: String?
    let scanned: Int?
}
