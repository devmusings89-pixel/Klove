import Foundation

// MARK: - Data sources (GET /sources, POST /sources/:type/connect)

/// The kinds of health-data sources Klove can ingest from. Raw values match the backend.
enum SourceType: String, CaseIterable, Identifiable, Codable {
    case healthkit
    case gmail
    case upload
    case imap
    case aggregator

    var id: String { rawValue }

    /// Sources surfaced in onboarding (the three the user picks from).
    static var onboardingSources: [SourceType] { [.healthkit, .gmail, .upload] }

    var title: String {
        switch self {
        case .healthkit: return "Apple Health"
        case .gmail: return "Email"
        case .upload: return "Photos & documents"
        case .imap: return "Email (IMAP)"
        case .aggregator: return "Connected providers"
        }
    }

    var subtitle: String {
        switch self {
        case .healthkit: return "Sync labs, conditions, medications, and vitals from the Health app."
        case .gmail: return "Pull results and records your providers email you."
        case .upload: return "Snap a photo of a lab result or upload a PDF."
        case .imap: return "Connect a mailbox to import health mail."
        case .aggregator: return "Import records directly from your clinics and labs."
        }
    }

    var systemImage: String {
        switch self {
        case .healthkit: return "heart.text.square.fill"
        case .gmail, .imap: return "envelope.fill"
        case .upload: return "doc.viewfinder.fill"
        case .aggregator: return "cross.case.fill"
        }
    }
}

/// One connected source for the current user (mirrors backend GET /sources).
struct SourceConnection: Codable, Hashable, Identifiable {
    let id: String
    let type: String
    let status: String          // connected | pending | error | revoked
    let externalAccountId: String?
    let lastSyncedAt: String?
    let lastError: String?

    var sourceType: SourceType? { SourceType(rawValue: type) }
    var isConnected: Bool { status == "connected" }
}

/// Result of POST /sources/:type/connect — either a stored connection or an OAuth redirect.
/// IMAP connects synchronously and reports its first scan (`scanned`/`queued`).
struct ConnectResponse: Codable, Hashable {
    let connectionId: String?
    let redirectUrl: String?
    let scanned: Int?
    let queued: Int?
}

/// Result of POST /sources/:type/sync — an on-demand "scan now".
struct SyncResponse: Codable, Hashable {
    let scanned: Int
    let queued: Int
}
