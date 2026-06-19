import Foundation

/// Drives the physician search screen: resolves a condition to ranked specialists with in-network
/// status. Search is explicit (button / submit) rather than per-keystroke — each query does specialty
/// resolution + a directory lookup, so we don't fire one on every character.
@MainActor
@Observable
final class PhysicianSearchModel {
    var condition = ""
    var location = ""
    var memberId: String
    var memberName: String

    /// Distance radius options (miles); 20 is the default.
    let radiusOptions = [5, 10, 20, 50]
    var radiusMiles = 20

    var results: [PhysicianResult] = []
    var resolvedSpecialty: String?
    var resolvedSubspecialty: String?
    var recommendation: PhysicianRecommendation?
    var recommending = false
    var memberInsurance: [String] = []
    var disclaimer = ""
    /// Per-card insurance status, verified lazily as each card appears (keyed by result id).
    var networkStatusById: [String: NetworkStatus] = [:]
    var verifyingIds: Set<String> = []
    var searching = false
    var loadingMore = false
    var hasSearched = false
    var nextOffset: Int?
    var errorMessage: String?
    var savedIds: Set<String> = []

    private let api = APIClient()

    init(memberId: String, memberName: String) {
        self.memberId = memberId
        self.memberName = memberName
    }

    var canSearch: Bool { !condition.trimmingCharacters(in: .whitespaces).isEmpty && !searching }
    var hasMore: Bool { nextOffset != nil }
    /// The radius only applies when a location is given.
    var radiusApplies: Bool { !location.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Fresh search (page 1): replaces results and fetches the recommendation.
    func search() async {
        let q = condition.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        defer { searching = false }
        do {
            let res = try await api.searchPhysicians(
                condition: q, memberId: memberId, location: location,
                radiusMiles: radiusApplies ? radiusMiles : nil, offset: 0
            )
            results = res.results
            networkStatusById = [:]
            verifyingIds = []
            resolvedSpecialty = res.resolvedSpecialty
            resolvedSubspecialty = res.resolvedSubspecialty
            recommendation = nil
            memberInsurance = res.memberInsurance
            disclaimer = res.disclaimer
            nextOffset = res.nextOffset
            hasSearched = true
            Task { await loadRecommendation(for: q) }   // load the recommendation async (reads reviews + LLM)
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Fetch Klove's recommendation in the background from the top results, so the list isn't blocked on it.
    private func loadRecommendation(for condition: String) async {
        guard !results.isEmpty else { return }
        recommending = true
        defer { recommending = false }
        let candidates = results.prefix(8).map {
            RecommendCandidateBody(name: $0.name, address: $0.address, taxonomyDesc: $0.taxonomyDesc,
                                   specialty: $0.specialty, rating: $0.rating, reviewCount: $0.reviewCount,
                                   distanceMiles: $0.distanceMiles)
        }
        recommendation = (try? await api.recommendPhysicians(condition: condition, candidates: Array(candidates))) ?? nil
    }

    /// "Load more": fetch the next page and append, keeping the existing recommendation.
    func loadMore() async {
        guard let offset = nextOffset, !loadingMore else { return }
        let q = condition.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let res = try await api.searchPhysicians(
                condition: q, memberId: memberId, location: location,
                radiusMiles: radiusApplies ? radiusMiles : nil, offset: offset
            )
            // De-dupe by id in case pages overlap.
            let existing = Set(results.map(\.id))
            results.append(contentsOf: res.results.filter { !existing.contains($0.id) })
            nextOffset = res.nextOffset
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// The best-known network status for a result: a lazily-verified value wins over the search default.
    func status(for r: PhysicianResult) -> NetworkStatus { networkStatusById[r.id] ?? r.networkStatus }
    func isVerifying(_ r: PhysicianResult) -> Bool { verifyingIds.contains(r.id) && networkStatusById[r.id] == nil }

    /// Verify one card's insurance lazily (called as the card appears). No-op when already known/in-flight.
    func verifyNetwork(_ r: PhysicianResult) async {
        guard !memberInsurance.isEmpty else { return }                 // nothing to check against
        guard r.networkStatus == .unconfirmed else { return }          // already decided (e.g. saved + tagged)
        guard networkStatusById[r.id] == nil, !verifyingIds.contains(r.id) else { return }
        verifyingIds.insert(r.id)
        defer { verifyingIds.remove(r.id) }
        if let resp = try? await api.physicianNetwork(name: r.name, address: r.address, website: r.website, memberId: memberId) {
            networkStatusById[r.id] = resp.networkStatus
        }
    }

    /// Save a search result to the household directory so it can be tagged + reused for booking.
    func save(_ p: PhysicianResult) async {
        do {
            _ = try await api.addProvider(
                name: p.name,
                phone: p.phone,
                website: p.website,
                address: p.address,
                specialty: resolvedSpecialty ?? p.specialty,
                memberId: memberId,
                npi: p.npi,
                source: "search"
            )
            savedIds.insert(p.id)
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }
}
