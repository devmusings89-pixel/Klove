import SwiftUI

/// A type-erased detail payload so one detail screen can render any record type.
struct RecordDetail: Hashable {
    let title: String
    let subtitle: String?
    let sourceType: String
    let confidence: Double
    let fields: [DetailField]
}

struct DetailField: Hashable, Identifiable {
    let label: String
    let value: String
    var id: String { label }
}

struct HealthRecordDetailView: View {
    let detail: RecordDetail

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(detail.title).font(.title3.bold())
                    if let subtitle = detail.subtitle {
                        Text(subtitle).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Details") {
                ForEach(detail.fields) { field in
                    LabeledContent(field.label, value: field.value)
                }
            }

            Section {
                Label(HealthFormat.source(detail.sourceType), systemImage: HealthFormat.sourceIcon(detail.sourceType))
                LabeledContent("Confidence", value: "\(Int(detail.confidence * 100))%")
            } header: {
                Text("Provenance")
            } footer: {
                Text("Extracted automatically. Always verify against the original record and discuss with your provider.")
            }
        }
        .navigationTitle("Record")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Record → RecordDetail mappings

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
