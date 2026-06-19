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

    var results: [PhysicianResult] = []
    var resolvedSpecialty: String?
    var resolvedSubspecialty: String?
    var disclaimer = ""
    var searching = false
    var hasSearched = false
    var errorMessage: String?
    var savedIds: Set<String> = []

    private let api = APIClient()

    init(memberId: String, memberName: String) {
        self.memberId = memberId
        self.memberName = memberName
    }

    var canSearch: Bool { !condition.trimmingCharacters(in: .whitespaces).isEmpty && !searching }

    func search() async {
        let q = condition.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        defer { searching = false }
        do {
            let res = try await api.searchPhysicians(condition: q, memberId: memberId, location: location)
            results = res.results
            resolvedSpecialty = res.resolvedSpecialty
            resolvedSubspecialty = res.resolvedSubspecialty
            disclaimer = res.disclaimer
            hasSearched = true
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
