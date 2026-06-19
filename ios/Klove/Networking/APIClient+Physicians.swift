import Foundation

/// Physician search — "find the best expert for my condition," ranked, with in-network status.
extension APIClient {
    /// Search for top specialists for a condition. `memberId` scopes the in-network check to that
    /// member's insurance; omit to search for the operator. `location` biases the directory ("Seattle, WA").
    /// `radiusMiles` limits to providers within that distance; `offset` pages results for "load more".
    func searchPhysicians(condition: String, memberId: String? = nil, location: String? = nil,
                          radiusMiles: Int? = nil, offset: Int = 0) async throws -> PhysicianSearchResponse {
        var items = [URLQueryItem(name: "condition", value: condition)]
        if let memberId { items.append(URLQueryItem(name: "memberId", value: memberId)) }
        if let location, !location.isEmpty { items.append(URLQueryItem(name: "location", value: location)) }
        if let radiusMiles { items.append(URLQueryItem(name: "radiusMiles", value: String(radiusMiles))) }
        if offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        var comps = URLComponents()
        comps.queryItems = items
        let query = comps.percentEncodedQuery ?? ""
        return try await get("/physicians/search?\(query)")
    }

    /// Load Klove's recommendation asynchronously after the search list renders (reads reviews + LLM).
    func recommendPhysicians(condition: String, candidates: [RecommendCandidateBody]) async throws -> PhysicianRecommendation? {
        let resp: RecommendationResponse = try await post("/physicians/recommendation", body: RecommendRequest(condition: condition, candidates: candidates))
        return resp.recommendation
    }

    /// Fast per-card network status — called lazily as each result appears so badges populate progressively.
    func physicianNetwork(name: String, address: String?, website: String?, memberId: String? = nil) async throws -> NetworkStatusResponse {
        var items = [URLQueryItem(name: "name", value: name)]
        if let address, !address.isEmpty { items.append(URLQueryItem(name: "address", value: address)) }
        if let website, !website.isEmpty { items.append(URLQueryItem(name: "website", value: website)) }
        if let memberId { items.append(URLQueryItem(name: "memberId", value: memberId)) }
        var comps = URLComponents()
        comps.queryItems = items
        return try await get("/physicians/network?\(comps.percentEncodedQuery ?? "")")
    }

    /// Detail view data for one provider: review snippets + accepted insurance scraped from their website,
    /// matched against the member's coverage for a confirmed network status.
    func physicianDetails(name: String, address: String?, website: String?, memberId: String? = nil) async throws -> PhysicianDetail {
        var items = [URLQueryItem(name: "name", value: name)]
        if let address, !address.isEmpty { items.append(URLQueryItem(name: "address", value: address)) }
        if let website, !website.isEmpty { items.append(URLQueryItem(name: "website", value: website)) }
        if let memberId { items.append(URLQueryItem(name: "memberId", value: memberId)) }
        var comps = URLComponents()
        comps.queryItems = items
        return try await get("/physicians/details?\(comps.percentEncodedQuery ?? "")")
    }
}

/// Detail payload from GET /physicians/details.
struct PhysicianDetail: Decodable {
    let reviews: [String]
    let acceptedCarriers: [String]
    let networkStatus: NetworkStatus
    let insuranceNote: String?
    let insuranceSourceUrl: String?
    let memberInsurance: [String]
}

/// In-network status for a physician relative to the member's insurance.
enum NetworkStatus: String, Decodable {
    case inNetwork = "in_network"
    case outOfNetwork = "out_of_network"
    case unconfirmed
    case unknown

    /// Short badge label.
    var label: String {
        switch self {
        case .inNetwork: return "In-network"
        case .outOfNetwork: return "Out-of-network"
        case .unconfirmed: return "Unconfirmed"
        case .unknown: return "No insurance"
        }
    }

    // Unknown future values decode to `.unknown` rather than throwing.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NetworkStatus(rawValue: raw) ?? .unknown
    }
}

/// A ranked specialist from GET /physicians/search.
struct PhysicianResult: Decodable, Identifiable, Hashable {
    let npi: String?
    let name: String
    let credential: String?
    let specialty: String
    let subspecialty: String?
    let taxonomyDesc: String?
    let address: String?
    let phone: String?
    let website: String?
    let rating: Double?
    let reviewCount: Int?
    let distanceMiles: Double?
    let matchReasons: [String]
    let networkStatus: NetworkStatus
    let source: String

    // Stable identity for ForEach: NPI when present, else name+address.
    var id: String { npi ?? "\(name)|\(address ?? "")" }
}

/// Response from GET /physicians/network.
struct NetworkStatusResponse: Decodable {
    let networkStatus: NetworkStatus
}

/// Minimal candidate sent to POST /physicians/recommendation.
struct RecommendCandidateBody: Encodable {
    let name: String
    let address: String?
    let taxonomyDesc: String?
    let specialty: String?
    let rating: Double?
    let reviewCount: Int?
    let distanceMiles: Double?
}

private struct RecommendRequest: Encodable {
    let condition: String
    let candidates: [RecommendCandidateBody]
}

private struct RecommendationResponse: Decodable {
    let recommendation: PhysicianRecommendation?
}

/// One ranked pick in Klove's recommendation.
struct RecommendationPick: Decodable, Hashable {
    let name: String
    let why: String
    let evidence: String?
    let caution: String?
}

/// Klove's structured recommendation, rendered natively.
struct PhysicianRecommendation: Decodable, Hashable {
    let summary: String
    let picks: [RecommendationPick]
}

/// The full response: resolved specialty, a recommendation, paging info, and ranked results.
struct PhysicianSearchResponse: Decodable {
    let resolvedSpecialty: String?
    let resolvedSubspecialty: String?
    let disclaimer: String
    let recommendation: PhysicianRecommendation?
    let radiusMiles: Double?
    let hasMore: Bool
    let nextOffset: Int?
    let memberInsurance: [String]
    let results: [PhysicianResult]
}
