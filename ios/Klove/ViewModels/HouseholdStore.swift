import SwiftUI

/// App-level household state shared across the Today / Family / Records / Actions tabs.
/// Holds the roster and the currently-selected member (whose data the member-scoped screens show).
@MainActor
@Observable
final class HouseholdStore {
    private let api = APIClient()

    var household: Household?
    var members: [HouseholdMember] = []
    var selectedMemberId: String?
    var isLoading = false
    var errorMessage: String?
    /// True once a load has succeeded at least once (distinguishes "failed" from "empty").
    var hasLoaded = false
    /// True when the last load failed to reach the backend.
    var loadFailed = false
    /// Bumped after a mutation (e.g. a booking) so other tabs reload their data.
    var dataVersion = 0

    /// Signal that household data changed so observing screens (Today, Actions) refresh.
    func bumpData() { dataVersion += 1 }

    /// The member currently in focus (defaults to the operator / self).
    var selectedMember: HouseholdMember? {
        if let id = selectedMemberId, let m = members.first(where: { $0.userId == id }) { return m }
        if let me = members.first(where: { $0.memberType == "self" }) { return me }
        return members.first
    }

    /// Members the operator can act on (self + active consent). Drives member-scoped pickers.
    var actionableMembers: [HouseholdMember] {
        members.filter { $0.consent == "self" || $0.consent == "active" }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let hh = try await api.getHousehold()
            household = hh
            members = hh.members
            if selectedMemberId == nil || !members.contains(where: { $0.userId == selectedMemberId }) {
                selectedMemberId = members.first { $0.memberType == "self" }?.userId ?? members.first?.userId
            }
            errorMessage = nil
            loadFailed = false
            hasLoaded = true
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            loadFailed = true
        }
    }

    @discardableResult
    func addMember(name: String, type: NewMemberType) async -> AddMemberResponse? {
        do {
            let created = try await api.addMember(displayName: name, type: type)
            await load()
            return created
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    func invite(memberId: String, email: String) async -> InviteResponse? {
        do { return try await api.inviteMember(memberId, email: email) }
        catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    func revoke(memberId: String) async {
        do { try await api.revokeConsent(memberId); await load() }
        catch { errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription }
    }

    func select(_ memberId: String) { selectedMemberId = memberId }
}
