import Foundation

/// Household, members, and consent endpoints (Phase 1). The transport (`get`/`post`/`patch`) and
/// the `x-user-email` mock identity header live in APIClient; these are thin typed wrappers.
extension APIClient {
    /// The operator's household + roster. Auto-created server-side on first call.
    func getHousehold() async throws -> Household {
        try await get("/household")
    }

    /// Name the household (onboarding / settings).
    @discardableResult
    func setHouseholdName(_ name: String) async throws -> EmptyResponse {
        try await post("/household", body: ["name": name])
    }

    /// Add a member. Minors/aging parents become managed members; adults are invited separately.
    func addMember(displayName: String, type: NewMemberType) async throws -> AddMemberResponse {
        try await post("/members", body: AddMemberBody(
            displayName: displayName,
            relationship: type.defaultRelationship,
            memberType: type.rawValue
        ))
    }

    /// Full detail + consent for one member.
    func getMember(_ userId: String) async throws -> MemberDetail {
        try await get("/members/\(userId)")
    }

    /// Invite a consenting adult by email; returns the deep link + single-use token.
    func inviteMember(_ userId: String, email: String) async throws -> InviteResponse {
        try await post("/members/\(userId)/invite", body: ["email": email])
    }

    /// Accept an invite as the logged-in (invitee) user, choosing what to share.
    @discardableResult
    func acceptInvite(token: String, categories: [String], accessLevel: String) async throws -> EmptyResponse {
        try await post("/invites/\(token)/accept", body: AcceptInviteBody(categories: categories, accessLevel: accessLevel))
    }

    /// Read the operator's consent over a member.
    func getConsent(_ userId: String) async throws -> MemberConsent {
        try await get("/members/\(userId)/consent")
    }

    /// Revoke access over a member (either side may call).
    @discardableResult
    func revokeConsent(_ userId: String) async throws -> EmptyResponse {
        try await post("/members/\(userId)/revoke", body: EmptyDict())
    }

    /// Edit a member's details (name / relationship).
    @discardableResult
    func updateMember(_ userId: String, displayName: String?, relationship: String?) async throws -> EmptyResponse {
        try await patch("/members/\(userId)", body: UpdateMemberBody(displayName: displayName, relationship: relationship))
    }

    /// Remove a member from the household (drops membership + revokes consent).
    @discardableResult
    func removeMember(_ userId: String) async throws -> EmptyResponse {
        try await delete("/members/\(userId)")
    }

    /// Change the operator's consent scope over a member (access level + categories).
    @discardableResult
    func updateConsent(_ userId: String, accessLevel: String, categories: [String]) async throws -> EmptyResponse {
        try await patch("/members/\(userId)/consent", body: UpdateConsentBody(accessLevel: accessLevel, categories: categories))
    }
}

private struct UpdateMemberBody: Encodable { let displayName: String?; let relationship: String? }
private struct UpdateConsentBody: Encodable { let accessLevel: String; let categories: [String] }

private struct AddMemberBody: Encodable {
    let displayName: String
    let relationship: String
    let memberType: String
}

private struct AcceptInviteBody: Encodable {
    let categories: [String]
    let accessLevel: String
}

private struct EmptyDict: Encodable {}
