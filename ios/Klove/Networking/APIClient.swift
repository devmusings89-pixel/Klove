import Foundation

/// Thin async client over the Klove backend.
struct APIClient {
    var baseURL: URL = Config.apiBaseURL
    private let session: URLSession = .shared

    func createSession(_ body: CreateSessionRequest) async throws -> CreateSessionResponse {
        try await post("/sessions", body: body)
    }

    func getSession(id: String) async throws -> SessionState {
        try await get("/sessions/\(id)")
    }

    /// All of the current user's booking sessions (newest first).
    func getSessions() async throws -> [SessionState] {
        try await get("/sessions")
    }

    /// Mock-mode payment confirmation (no Stripe). Replaced by PaymentSheet in Phase 3.
    func confirmMockPayment(id: String) async throws {
        let _: EmptyResponse = try await post("/sessions/\(id)/confirm-mock-payment", body: EmptyBody())
    }

    /// Patient picks an offered slot; backend places the booking callback.
    func chooseSlot(sessionId: String, targetId: String, slot: String) async throws {
        let _: EmptyResponse = try await post(
            "/sessions/\(sessionId)/choose",
            body: ChooseSlotBody(targetId: targetId, slot: slot)
        )
    }

    /// Patient supplies info the office required; backend re-calls with it.
    func provideInfo(sessionId: String, targetId: String, answers: String) async throws {
        let _: EmptyResponse = try await post(
            "/sessions/\(sessionId)/provide-info",
            body: ProvideInfoBody(targetId: targetId, answers: answers)
        )
    }

    /// Patient enters the one-time code an online scheduler sent; backend resumes & confirms.
    func verify(sessionId: String, targetId: String, code: String) async throws {
        let _: EmptyResponse = try await post(
            "/sessions/\(sessionId)/verify",
            body: VerifyBody(targetId: targetId, code: code)
        )
    }

    // MARK: - Natural-language booking intake

    /// Turn a free-text request into a structured BookingDraft (slot-filling, one turn at a time).
    func parseIntake(text: String, draft: BookingDraft?) async throws -> BookingDraft {
        try await post("/intake/parse", body: IntakeParseBody(text: text, draft: draft))
    }

    // MARK: - Profile + insurance

    /// The user's reusable profile (demographics + insurance), or nil if not set up yet.
    func getProfile() async throws -> UserProfile? {
        let r: ProfileResponse = try await get("/profile")
        return r.profile
    }

    /// Save the user's demographics.
    @discardableResult
    func putProfile(fullName: String, dob: String?, phone: String?, email: String?, address: String?) async throws -> UserProfile? {
        let r: ProfileResponse = try await put("/profile", body: ProfileBody(fullName: fullName, dob: dob, phone: phone, email: email, address: address))
        return r.profile
    }

    /// Save the user's insurance (member/group IDs are encrypted server-side).
    @discardableResult
    func putInsurance(_ info: InsuranceInfo) async throws -> UserProfile? {
        let r: ProfileResponse = try await put("/profile/insurance", body: info)
        return r.profile
    }

    // MARK: - Health data sources

    /// The current user's connected data sources.
    func getSources() async throws -> [SourceConnection] {
        try await get("/sources")
    }

    /// Begin connecting a source. OAuth sources return a `redirectUrl` for the client to open.
    func connectSource(_ type: SourceType, params: [String: String] = [:]) async throws -> ConnectResponse {
        try await post("/sources/\(type.rawValue)/connect", body: params)
    }

    /// Scan a connected source on demand. Returns how many items it pulled and queued.
    func syncSource(_ type: SourceType) async throws -> SyncResponse {
        try await post("/sources/\(type.rawValue)/sync", body: EmptyBody())
    }

    /// Revoke a connected source.
    func disconnectSource(_ type: SourceType) async throws {
        let _: EmptyResponse = try await post("/sources/\(type.rawValue)/disconnect", body: EmptyBody())
    }

    /// Push HealthKit FHIR resources read on-device to the backend for normalization.
    func syncHealthKit(resources: [String]) async throws {
        let _: EmptyResponse = try await post("/sources/healthkit/sync", body: HealthKitSyncBody(resources: resources))
    }

    // MARK: - Health records

    /// The user's normalized health record set.
    func getHealthRecords() async throws -> HealthRecords {
        try await get("/health-records")
    }

    /// Alerts surfaced by the analysis pass.
    func getAlerts() async throws -> [HealthAlert] {
        try await get("/health-records/alerts")
    }

    /// Appointments parsed from email/documents, soonest first.
    func getAppointments() async throws -> [Appointment] {
        try await get("/appointments")
    }

    /// Acknowledge (dismiss) an alert.
    func ackAlert(id: String) async throws {
        let _: EmptyResponse = try await post("/health-records/alerts/\(id)/ack", body: EmptyBody())
    }

    /// Extraction status for an ingested document.
    func getDocumentStatus(id: String) async throws -> DocumentStatus {
        try await get("/health-records/documents/\(id)")
    }

    /// Upload a document (photo/PDF) for extraction via multipart/form-data.
    func uploadDocument(data: Data, mimeType: String, filename: String) async throws -> UploadResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: baseURL.appendingPathComponent("/uploads"))
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

    // MARK: - Transport

    /// Bearer token (Supabase JWT) when signed in; preferred over the dev email header.
    /// Stored in the Keychain (not UserDefaults) so the JWT is encrypted at rest.
    private var authToken: String { KeychainStore.get(AppStorageKey.authToken) ?? "" }
    /// Fallback identity: backend resolves the user from this header when there's no bearer token.
    private var userEmail: String { UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "" }

    func get<R: Decodable>(_ path: String) async throws -> R {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "GET"
        return try await send(req)
    }

    func post<B: Encodable, R: Decodable>(_ path: String, body: B) async throws -> R {
        try await sendBody(path, method: "POST", body: body)
    }

    func patch<B: Encodable, R: Decodable>(_ path: String, body: B) async throws -> R {
        try await sendBody(path, method: "PATCH", body: body)
    }

    @discardableResult
    func delete<R: Decodable>(_ path: String) async throws -> R {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "DELETE"
        return try await send(req)
    }

    func put<B: Encodable, R: Decodable>(_ path: String, body: B) async throws -> R {
        try await sendBody(path, method: "PUT", body: body)
    }

    private func sendBody<B: Encodable, R: Decodable>(_ path: String, method: String, body: B) async throws -> R {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try await send(req)
    }

    func send<R: Decodable>(_ req: URLRequest) async throws -> R {
        var req = req
        if !authToken.isEmpty {
            req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        } else if !userEmail.isEmpty {
            req.setValue(userEmail, forHTTPHeaderField: "x-user-email")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw AppError.networkError(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw AppError.server(status: -1, message: "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            // A 401 means our Supabase session is gone/expired — clear it so the app routes back to
            // sign-in instead of every screen showing a misleading "Couldn't reach Klove".
            if http.statusCode == 401 { await AuthService.shared.sessionExpired() }
            throw AppError.server(status: http.statusCode, message: String(data: data, encoding: .utf8) ?? "")
        }
        if R.self == EmptyResponse.self { return EmptyResponse() as! R }
        do {
            return try JSONDecoder().decode(R.self, from: data)
        } catch {
            throw AppError.decoding(underlying: error)
        }
    }
}

private struct EmptyBody: Encodable {}
private struct HealthKitSyncBody: Encodable {
    let resources: [String]
}
private struct ChooseSlotBody: Encodable {
    let targetId: String
    let slot: String
}
private struct ProvideInfoBody: Encodable {
    let targetId: String
    let answers: String
}
private struct VerifyBody: Encodable {
    let targetId: String
    let code: String
}
private struct IntakeParseBody: Encodable {
    let text: String
    let draft: BookingDraft?
}
private struct ProfileBody: Encodable {
    let fullName: String
    let dob: String?
    let phone: String?
    let email: String?
    let address: String?
}
struct EmptyResponse: Decodable {}

extension Data {
    /// Append a UTF-8 string (used to assemble multipart/form-data bodies).
    mutating func append(_ string: String) {
        if let data = string.data(using: .utf8) { append(data) }
    }
}
