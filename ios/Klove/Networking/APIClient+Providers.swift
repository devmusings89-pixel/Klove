import Foundation

/// The household's known-provider directory — list past providers, search (directory + Places), add new.
extension APIClient {
    /// List the directory, optionally biased to a member (their providers + household-wide shared ones).
    func listProviders(memberId: String? = nil) async throws -> [DirectoryProvider] {
        let q = memberId.map { "?memberId=\($0)" } ?? ""
        return try await get("/providers\(q)")
    }

    /// Search the directory + Google Places (the add-provider picker; debounce on the client).
    func searchProviders(_ query: String) async throws -> ProviderSearchResult {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await get("/providers/search?q=\(q)")
    }

    /// Add (or refresh) a provider in the directory. `memberId` scopes it to a member; omit for shared.
    @discardableResult
    func addProvider(name: String, phone: String? = nil, website: String? = nil, address: String? = nil, specialty: String? = nil, memberId: String? = nil) async throws -> DirectoryProvider {
        try await post("/providers", body: AddProviderBody(name: name, phone: phone, website: website, address: address, specialty: specialty, memberId: memberId))
    }
}

/// A saved provider in the household's directory (GET /providers).
struct DirectoryProvider: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let phone: String?
    let website: String?
    let address: String?
    let specialty: String?
    let source: String
    let subjectUserId: String?
}

/// Result of GET /providers/search — saved providers plus fresh Google Places matches.
struct ProviderSearchResult: Decodable {
    let directory: [DirectoryProvider]
    let places: [OfficeMatch]
}

private struct AddProviderBody: Encodable {
    let name: String
    let phone: String?
    let website: String?
    let address: String?
    let specialty: String?
    let memberId: String?
}
