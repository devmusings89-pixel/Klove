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
    var memberInsurance: [String] = []
    var disclaimer = ""
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
            resolvedSpecialty = res.resolvedSpecialty
            resolvedSubspecialty = res.resolvedSubspecialty
            recommendation = res.recommendation
            memberInsurance = res.memberInsurance
            disclaimer = res.disclaimer
            nextOffset = res.nextOffset
            hasSearched = true
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
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
