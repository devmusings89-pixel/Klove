import SwiftUI

/// Small display helpers shared across the health screens.
enum HealthFormat {
    /// Parse an ISO timestamp (with or without fractional seconds) to a Date.
    static func parseDate(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// Render an ISO timestamp as a short local date ("Jun 14, 2026"); falls back to the raw prefix.
    static func date(_ iso: String?) -> String {
        guard let iso else { return "—" }
        guard let date = parseDate(iso) else { return String(iso.prefix(10)) }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// Render an ISO timestamp as date + time ("Jun 24, 2026 at 2:00 PM").
    static func dateTime(_ iso: String?) -> String {
        guard let date = parseDate(iso) else { return iso.map { String($0.prefix(10)) } ?? "Date TBD" }
        return date.formatted(.dateTime.month(.abbreviated).day().year().hour().minute())
    }

    /// Friendly label for a source type raw value.
    static func source(_ raw: String) -> String {
        SourceType(rawValue: raw)?.title ?? raw.capitalized
    }

    static func sourceIcon(_ raw: String) -> String {
        SourceType(rawValue: raw)?.systemImage ?? "doc.fill"
    }

    /// Color for an alert severity.
    static func severityColor(_ severity: String) -> Color {
        switch severity {
        case "urgent": return .red
        case "watch": return .orange
        default: return .blue
        }
    }

    static func severityIcon(_ severity: String) -> String {
        switch severity {
        case "urgent": return "exclamationmark.octagon.fill"
        case "watch": return "exclamationmark.triangle.fill"
        default: return "info.circle.fill"
        }
    }
}
