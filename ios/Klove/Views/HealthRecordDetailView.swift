import SwiftUI

/// A type-erased detail payload so one detail screen can render any record type. The optional fields
/// drive the V1 editorial layout (meaning panel, trend bars, status flag) when the source provides
/// them; typed-record mappings that don't set them simply render the numbers + provenance.
struct RecordDetail: Hashable {
    let title: String
    let subtitle: String?
    let sourceType: String
    let confidence: Double
    let fields: [DetailField]
    /// "What this means" plain-language explanation.
    var meaning: String? = nil
    /// Tracked-caps meta line, e.g. "JANA · JUN 2 · OHSU".
    var metaLine: String? = nil
    /// Emphasis flag chip, e.g. "HIGH".
    var statusFlag: String? = nil
    /// Optional trend series for "THE TREND".
    var series: [TrendBars.Point] = []
    /// Seed prompt for "Ask Klove about this".
    var askSeed: String? = nil
}

struct DetailField: Hashable, Identifiable {
    let label: String
    let value: String
    var emphasized: Bool = false
    var id: String { label }
}

struct HealthRecordDetailView: View {
    let detail: RecordDetail
    @State private var showAsk = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                // Title block
                VStack(alignment: .leading, spacing: 6) {
                    if let meta = detail.metaLine {
                        Text(meta).font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
                    }
                    Text(detail.title).font(.kloveSerifHeading).foregroundStyle(Theme.ink)
                }

                if let meaning = detail.meaning {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        SectionLabel(title: "What this means")
                        Text(meaning).font(.kloveBody).foregroundStyle(Theme.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .kloveCardSunken()
                    }
                }

                if !detail.series.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        SectionLabel(title: "The trend")
                        TrendBars(points: detail.series).padding(.top, 4)
                    }
                }

                if !detail.fields.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        SectionLabel(title: "The numbers")
                        VStack(spacing: 0) {
                            ForEach(Array(detail.fields.enumerated()), id: \.element.id) { i, field in
                                if i > 0 { Divider().overlay(Theme.hairline) }
                                HStack {
                                    Text(field.label).font(.kloveBody).foregroundStyle(Theme.ink)
                                    Spacer()
                                    if field.emphasized {
                                        StatusChip(text: field.value, emphasized: true)
                                    } else {
                                        Text(field.value).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                                    }
                                }
                                .padding(.vertical, 14)
                            }
                        }
                        .padding(.horizontal, Theme.Spacing.lg)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
                    }
                }

                // Provenance caption
                HStack(spacing: 8) {
                    Circle().fill(Theme.surfaceSunken).frame(width: 18, height: 18)
                        .overlay(Image(systemName: HealthFormat.sourceIcon(detail.sourceType)).font(.system(size: 9)).foregroundStyle(Theme.inkSecondary))
                    Text("Source: \(HealthFormat.source(detail.sourceType)) · \(Int(detail.confidence * 100))% confidence".uppercased())
                        .font(.system(size: 10, weight: .semibold)).tracking(0.8).foregroundStyle(Theme.inkSecondary)
                }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            Button { showAsk = true } label: { Text("Ask Klove about this") }
                .buttonStyle(KlovePrimaryButtonStyle())
                .padding(.horizontal, Theme.Spacing.xl).padding(.vertical, Theme.Spacing.md)
                .background(.ultraThinMaterial)
        }
        .navigationTitle("Record")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: detail.title) { Image(systemName: "square.and.arrow.up") }
            }
        }
        .sheet(isPresented: $showAsk) {
            AskKloveView(seed: detail.askSeed ?? "Tell me about \(detail.title)")
        }
    }
}

// MARK: - Record → RecordDetail mappings

extension TimelineEntry {
    /// Map a clean timeline entry into the detail payload for the editorial record screen.
    var recordDetail: RecordDetail {
        var fields = [DetailField(label: "Date", value: displayDate),
                      DetailField(label: "Source", value: source.capitalized)]
        if abnormal == true { fields.append(DetailField(label: "Status", value: "Abnormal", emphasized: true)) }
        return RecordDetail(
            title: title,
            subtitle: kind.capitalized,
            sourceType: source,
            confidence: 1.0,
            fields: fields,
            meaning: detail,
            metaLine: "\(kind.uppercased()) · \(displayDate) · \(source.uppercased())",
            statusFlag: abnormal == true ? "ABNORMAL" : nil,
            askSeed: "Tell me about \(title) — what does it mean for them?"
        )
    }
}


extension ObservationRecord {
    var detail: RecordDetail {
        var fields = [DetailField(label: "Value", value: valueText)]
        if let referenceRange { fields.append(DetailField(label: "Reference range", value: referenceRange)) }
        if isAbnormal, let flag = abnormalFlag { fields.append(DetailField(label: "Flag", value: flag.uppercased())) }
        if let code { fields.append(DetailField(label: "LOINC", value: code)) }
        fields.append(DetailField(label: "Date", value: HealthFormat.date(effectiveAt ?? recordedAt)))
        return RecordDetail(title: display, subtitle: isAbnormal ? "Out of range" : nil,
                            sourceType: sourceType, confidence: confidence, fields: fields)
    }
}

extension Condition {
    var detail: RecordDetail {
        var fields: [DetailField] = []
        if let clinicalStatus { fields.append(DetailField(label: "Status", value: clinicalStatus.capitalized)) }
        if let severity { fields.append(DetailField(label: "Severity", value: severity.capitalized)) }
        if let onsetDate { fields.append(DetailField(label: "Onset", value: HealthFormat.date(onsetDate))) }
        if let code { fields.append(DetailField(label: "ICD-10 / SNOMED", value: code)) }
        fields.append(DetailField(label: "Recorded", value: HealthFormat.date(recordedAt)))
        return RecordDetail(title: display, subtitle: "Condition", sourceType: sourceType, confidence: confidence, fields: fields)
    }
}

extension Medication {
    var detail: RecordDetail {
        var fields: [DetailField] = []
        if let dosage { fields.append(DetailField(label: "Dosage", value: dosage)) }
        if let status { fields.append(DetailField(label: "Status", value: status.capitalized)) }
        if let startDate { fields.append(DetailField(label: "Started", value: HealthFormat.date(startDate))) }
        if let endDate { fields.append(DetailField(label: "Ended", value: HealthFormat.date(endDate))) }
        fields.append(DetailField(label: "Recorded", value: HealthFormat.date(recordedAt)))
        return RecordDetail(title: display, subtitle: "Medication", sourceType: sourceType, confidence: confidence, fields: fields)
    }
}

extension DiagnosticReport {
    var detail: RecordDetail {
        var fields: [DetailField] = []
        if let category { fields.append(DetailField(label: "Category", value: category.capitalized)) }
        fields.append(DetailField(label: "Issued", value: HealthFormat.date(issuedAt ?? recordedAt)))
        return RecordDetail(title: display, subtitle: "Report", sourceType: sourceType, confidence: confidence, fields: fields)
    }
}

extension Allergy {
    var detail: RecordDetail {
        var fields: [DetailField] = []
        if let reaction { fields.append(DetailField(label: "Reaction", value: reaction)) }
        if let severity { fields.append(DetailField(label: "Severity", value: severity.capitalized)) }
        fields.append(DetailField(label: "Recorded", value: HealthFormat.date(recordedAt)))
        return RecordDetail(title: substance, subtitle: "Allergy", sourceType: sourceType, confidence: confidence, fields: fields)
    }
}
