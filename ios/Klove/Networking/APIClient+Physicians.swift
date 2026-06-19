import Foundation

/// Physician search — "find the best expert for my condition," ranked, with in-network status.
extension APIClient {
    /// Search for top specialists for a condition. `memberId` scopes the in-network check to that
    /// member's insurance; omit to search for the operator. `location` biases the directory ("Seattle, WA").
    func searchPhysicians(condition: String, memberId: String? = nil, location: String? = nil) async throws -> PhysicianSearchResponse {
        var items = [URLQueryItem(name: "condition", value: condition)]
        if let memberId { items.append(URLQueryItem(name: "memberId", value: memberId)) }
        if let location, !location.isEmpty { items.append(URLQueryItem(name: "location", value: location)) }
        var comps = URLComponents()
        comps.queryItems = items
        let query = comps.percentEncodedQuery ?? ""
        return try await get("/physicians/search?\(query)")
    }
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
    let matchReasons: [String]
    let networkStatus: NetworkStatus
    let source: String

    // Stable identity for ForEach: NPI when present, else name+address.
    var id: String { npi ?? "\(name)|\(address ?? "")" }
}

/// The full response: the resolved specialty, a quality/network disclaimer, and ranked results.
struct PhysicianSearchResponse: Decodable {
    let resolvedSpecialty: String?
    let resolvedSubspecialty: String?
    let disclaimer: String
    let results: [PhysicianResult]
}
