import Foundation

/// The operator's household and its roster, as returned by `GET /household`.
struct Household: Decodable {
    let id: String
    let name: String?
    let operatorUserId: String
    let members: [HouseholdMember]
}

/// One member row in the Family tab. `consent` is the operator's relationship to this member:
/// "self" | "active" | "pending" | "revoked" | "none".
struct HouseholdMember: Decodable, Identifiable, Hashable {
    let userId: String
    let displayName: String?
    let relationship: String
    let memberType: String
    let isOperator: Bool
    let managed: Bool
    let consent: String
    let needsYou: Int

    var id: String { userId }
    var name: String { displayName ?? "Member" }

    /// SF Symbol for the member's relationship/type.
    var symbol: String {
        switch memberType {
        case "self": return "person.fill"
        case "minor": return "figure.child"
        case "aging_parent": return "figure.2.arms.open"
        default: return "person.2.fill"
        }
    }
}

/// Detailed member view from `GET /members/:id`.
struct MemberDetail: Decodable {
    let userId: String
    let displayName: String?
    let dob: String?
    let relationship: String
    let memberType: String
    let isOperator: Bool
    let managed: Bool
    let consent: MemberConsent
}

/// The operator's consent over a member: access level + which data categories are shared.
struct MemberConsent: Decodable, Hashable {
    let status: String          // self | active | pending | revoked | none
    let accessLevel: String?    // view | manage | operate
    let categories: [String]    // all | records | apple_health | appointments
}

/// Member types the operator can add (self is created with the household).
enum NewMemberType: String, CaseIterable, Identifiable {
    case minor
    case agingParent = "aging_parent"
    case consentingAdult = "consenting_adult"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .minor: return "Child"
        case .agingParent: return "Aging parent"
        case .consentingAdult: return "Another adult"
        }
    }
    var blurb: String {
        switch self {
        case .minor: return "You manage their care (guardianship). No separate login."
        case .agingParent: return "You coordinate on their behalf (delegated). No separate login."
        case .consentingAdult: return "They install Klove and choose what to share with you."
        }
    }
    var defaultRelationship: String {
        switch self {
        case .minor: return "child"
        case .agingParent: return "parent"
        case .consentingAdult: return "adult"
        }
    }
}

// MARK: - Response payloads

struct InviteResponse: Decodable {
    let ok: Bool
    let token: String
    let link: String
    let deepLink: String
    let emailed: Bool
}

struct AddMemberResponse: Decodable {
    let userId: String
    let displayName: String?
    let memberType: String
    let consent: String
}
