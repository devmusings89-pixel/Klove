import Foundation

// MARK: - Normalized health record (GET /health-records)
// Field names mirror the backend Prisma rows. Dates are decoded as ISO strings for display.

struct ObservationRecord: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let code: String?
    let display: String
    let valueNum: Double?
    let valueString: String?
    let unit: String?
    let referenceRange: String?
    let abnormalFlag: String?
    let effectiveAt: String?
    let recordedAt: String
    let confidence: Double
    let reportId: String?

    /// Human value, e.g. "142 mg/dL". Uses a NumberFormatter so we don't leak full float precision
    /// (e.g. "129.7300000001") into the UI.
    var valueText: String {
        if let valueNum {
            let n = ObservationRecord.valueFormatter.string(from: NSNumber(value: valueNum)) ?? String(valueNum)
            return unit.map { "\(n) \($0)" } ?? n
        }
        return valueString ?? "—"
    }

    /// Up to 2 significant decimals, integers render without a trailing ".0".
    private static let valueFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = 2
        return f
    }()
    var isAbnormal: Bool { (abnormalFlag ?? "").uppercased() != "" && (abnormalFlag ?? "").uppercased() != "N" }
}

struct Condition: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let code: String?
    let display: String
    let clinicalStatus: String?
    let onsetDate: String?
    let severity: String?
    let recordedAt: String
    let confidence: Double
}

struct Medication: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let display: String
    let rxNormCode: String?
    let dosage: String?
    let status: String?
    let startDate: String?
    let endDate: String?
    let recordedAt: String
    let confidence: Double
}

struct DiagnosticReport: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let display: String
    let category: String?
    let issuedAt: String?
    let recordedAt: String
    let confidence: Double
}

struct Allergy: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let substance: String
    let reaction: String?
    let severity: String?
    let recordedAt: String
    let confidence: Double
}

/// The full record set (mirrors backend GET /health-records).
struct HealthRecords: Codable, Hashable {
    var observations: [ObservationRecord] = []
    var conditions: [Condition] = []
    var medications: [Medication] = []
    var reports: [DiagnosticReport] = []
    var allergies: [Allergy] = []

    var isEmpty: Bool {
        observations.isEmpty && conditions.isEmpty && medications.isEmpty && reports.isEmpty && allergies.isEmpty
    }
    var totalCount: Int {
        observations.count + conditions.count + medications.count + reports.count + allergies.count
    }
}

// MARK: - Appointments (GET /appointments)

struct Appointment: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let title: String
    let provider: String?
    let location: String?
    let startsAt: String?
    let endsAt: String?
    let status: String
    let confirmation: String?
    let notes: String?
    let confidence: Double
    var verified: Bool? = nil

    /// A confirmed-looking visit Klove only provisionally held (no live office confirmation).
    var isProvisional: Bool { verified == false }

    /// True when the appointment is in the future, or has no date yet (nil). A *present but
    /// unparseable* `startsAt` is a data error, not a future appointment: log it and treat it as not
    /// upcoming so a bad date doesn't masquerade as a valid future event.
    var isUpcoming: Bool {
        guard let startsAt else { return true } // no date set yet
        guard let date = HealthFormat.parseDate(startsAt) else {
            assertionFailure("Appointment.startsAt failed to parse: \(startsAt)")
            return false
        }
        return date >= Date()
    }
}

// MARK: - Alerts (GET /health-records/alerts)

struct HealthAlert: Codable, Hashable, Identifiable {
    let id: String
    let severity: String        // info | watch | urgent
    let title: String
    let detail: String
    let relatedResourceIds: [String]
    let acknowledgedAt: String?
    let createdAt: String

    var isAcknowledged: Bool { acknowledgedAt != nil }
}

// MARK: - Uploads (POST /uploads, GET /health-records/documents/:id)

struct UploadResponse: Codable, Hashable {
    let documentId: String
    let status: String          // queued | duplicate
}

struct DocumentJob: Codable, Hashable {
    let kind: String
    let status: String
    let summary: String?
}

struct DocumentStatus: Codable, Hashable, Identifiable {
    let id: String
    let sourceType: String
    let mimeType: String
    let originalName: String?
    let status: String          // queued | extracting | extracted | failed | skipped_non_health
    let lastJob: DocumentJob?
    let createdAt: String

    var isTerminal: Bool { ["extracted", "failed", "skipped_non_health"].contains(status) }
}
