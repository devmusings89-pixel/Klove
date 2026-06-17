import Foundation

// MARK: - Request payloads (POST /sessions)

struct PatientInfo: Codable, Hashable {
    var name: String = ""
    var dob: String = ""            // ISO date "yyyy-MM-dd"
    var reason: String = ""
    var insurance: String = ""
    var preferredTimes: String = ""
    // If a slot falls within this window, the AI auto-books it without asking the patient.
    var acceptableWindow: String = ""
    // Free-form extra details the office may ask for (member ID, referral, pharmacy, etc.).
    var additionalInfo: String = ""
    // Patient's own phone — used to warm-transfer or re-call when the agent is stumped. Also where
    // online schedulers send the booking verification code.
    var patientPhone: String = ""
    // Patient's email — required by many online booking forms; also a verification-code destination.
    var patientEmail: String = ""
}

struct CallTargetInput: Codable, Hashable, Identifiable {
    var id = UUID()
    var officeName: String = ""
    var phoneNumber: String = ""    // optional; empty => looked up by backend
    var website: String = ""        // optional online-booking URL (web channel)
    var email: String = ""          // optional office email (email fallback channel)
    var timezone: String = "America/New_York"

    // Only send fields the API expects.
    enum CodingKeys: String, CodingKey { case officeName, phoneNumber, website, email, timezone }
}

struct CreateSessionRequest: Codable {
    let email: String
    let patientInfo: PatientInfo
    let targets: [CallTargetInput]
    let stopWhenBooked: Bool
}

struct CreateSessionResponse: Codable {
    let sessionId: String
}

// MARK: - Profile + insurance vault (/profile)

struct InsuranceInfo: Codable, Hashable {
    var carrier: String?
    var planName: String?
    var memberId: String?
    var groupId: String?
    var rxBin: String?
    var rxPcn: String?
    var holderName: String?

    var isEmpty: Bool {
        [carrier, planName, memberId, groupId, rxBin, rxPcn, holderName].allSatisfy { ($0 ?? "").isEmpty }
    }
}

struct UserProfile: Codable, Hashable {
    var id: String?
    var fullName: String = ""
    var dob: String?
    var phone: String?
    var email: String?
    var address: String?
    var insurance: InsuranceInfo?
}

struct ProfileResponse: Codable {
    let profile: UserProfile?
}

// MARK: - Natural-language intake (POST /intake/parse)

/// A reusable provider surfaced from the user's past appointments.
struct ProviderCandidate: Codable, Hashable, Identifiable {
    let officeName: String
    let phoneNumber: String?
    let website: String?
    let location: String?
    let lastSeen: String?
    let source: String?
    var id: String { officeName }
}

/// The structured booking task the assistant builds up across the conversation.
struct BookingDraft: Codable, Hashable {
    var reason: String?
    var specialty: String?
    var providerHint: String?
    var location: String?
    var preferredTimes: String?
    var acceptableWindow: String?
    var urgency: String?
    var patientName: String?
    var assistantMessage: String
    var nextQuestion: String?
    var missingSlots: [String]
    var providerCandidates: [ProviderCandidate]
    var readyToBook: Bool

    /// A short human label for what's being booked.
    var visitLabel: String {
        reason ?? specialty.map { "\($0) visit" } ?? "a visit"
    }
}

// MARK: - Session state (GET /sessions/:id)

struct CallStructuredData: Codable, Hashable {
    let outcome: String         // booked | options_collected | no_availability | no_human | failed
    let appointmentBooked: Bool
    let appointmentDateTime: String
    let confirmation: String
    let offeredSlots: [String]
    let notes: String
    var missingInfo: [String]? = nil   // info the office still needs (decoded when present)
}

struct CallResult: Codable, Hashable {
    let phase: String?          // gather | book | single
    let channel: String?        // voice | web | fhir | ...
    let transcript: String?
    let summary: String?
    let structuredData: CallStructuredData?
    let recordingUrl: String?
    let endedReason: String?
    let durationSec: Int?
    let createdAt: String?

    /// "2:14 PM · 3m 20s" — when the call happened and how long it lasted, when known.
    var whenDuration: String? {
        var parts: [String] = []
        if let s = createdAt, let d = ISO8601DateFormatter().date(from: s) {
            let f = DateFormatter(); f.dateFormat = "MMM d, h:mm a"
            parts.append("Called \(f.string(from: d))")
        }
        if let secs = durationSec, secs > 0 {
            parts.append(secs >= 60 ? "\(secs / 60)m \(secs % 60)s" : "\(secs)s")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct CallTarget: Codable, Hashable, Identifiable {
    let id: String
    let officeName: String
    let phoneNumber: String?
    let timezone: String
    let order: Int
    let status: String          // pending | calling | awaiting_choice | awaiting_info | awaiting_verification | booked | transferred | requested | voicemail | failed | no_answer
    let channel: String?        // channel that handled this office: voice | web | ...
    let website: String?
    let offeredSlots: [String]
    let chosenSlot: String?
    let missingInfo: [String]
    let verificationContact: String?   // where the scheduler sent the one-time code
    let result: CallResult?     // latest call
    let results: [CallResult]   // full history (gather + callbacks)
}

/// One pickable option, flattened across offices (mirrors backend `aggregatedOptions`).
struct AggregatedOption: Codable, Hashable, Identifiable {
    let targetId: String
    let officeName: String
    let slot: String
    var id: String { "\(targetId)|\(slot)" }
}

/// An office's request for missing info (mirrors backend `infoRequests`).
struct InfoRequest: Codable, Hashable, Identifiable {
    let targetId: String
    let officeName: String
    let missingInfo: [String]
    var id: String { targetId }
}

/// An office's request for a one-time verification code (mirrors backend `verificationRequests`).
struct VerificationRequest: Codable, Hashable, Identifiable {
    let targetId: String
    let officeName: String
    let contact: String?        // e.g. "your email" / "your phone"
    let slot: String?
    var id: String { targetId }
}

struct SessionState: Codable, Hashable, Identifiable {
    let id: String
    let status: String          // draft | paid | scheduling | in_progress | awaiting_choice | awaiting_info | awaiting_verification | completed | failed
    let patientInfo: PatientInfo?
    let maxCalls: Int
    let minutesCap: Int
    let stopWhenBooked: Bool
    let aggregatedOptions: [AggregatedOption]
    let infoRequests: [InfoRequest]
    let verificationRequests: [VerificationRequest]
    let targets: [CallTarget]

    var isTerminal: Bool { status == "completed" || status == "failed" }
    var needsChoice: Bool { status == "awaiting_choice" }
    var needsInfo: Bool { status == "awaiting_info" }
    var needsVerification: Bool { status == "awaiting_verification" }
}
