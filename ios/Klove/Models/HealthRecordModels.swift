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

    /// Human value, e.g. "142 mg/dL".
    var valueText: String {
        if let valueNum {
            let n = valueNum == valueNum.rounded() ? String(Int(valueNum)) : String(valueNum)
            return unit.map { "\(n) \($0)" } ?? n
        }
        return valueString ?? "—"
    }
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

    /// True when the appointment is in the future (or has no parsed date yet).
    var isUpcoming: Bool {
        guard let date = HealthFormat.parseDate(startsAt) else { return true }
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
