import SwiftUI

/// The user's full normalized health record, grouped by type. Must be hosted in a NavigationStack.
struct HealthRecordsListView: View {
    @State private var model = HealthRecordsModel()
    @State private var showUpload = false

    var body: some View {
        Group {
            if model.records.isEmpty && !model.isLoading {
                emptyState
            } else {
                list
            }
        }
        .navigationTitle("Records")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink { AppointmentsView() } label: { Image(systemName: "calendar") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add", systemImage: "plus") { showUpload = true }
            }
        }
        .sheet(isPresented: $showUpload, onDismiss: { Task { await model.load() } }) {
            UploadView()
        }
        .navigationDestination(for: RecordDetail.self) { HealthRecordDetailView(detail: $0) }
        .task { await model.load() }
        .refreshable { await model.load() }
        .overlay { if model.isLoading { ProgressView() } }
    }

    private var list: some View {
        List {
            if let error = model.errorMessage {
                Section { Text(error).foregroundStyle(.red) }
            }
            recordSection("Conditions", systemImage: "stethoscope", items: model.records.conditions,
                          title: \.display, subtitle: { $0.clinicalStatus?.capitalized }, detail: \.detail)
            recordSection("Medications", systemImage: "pills.fill", items: model.records.medications,
                          title: \.display, subtitle: { $0.dosage }, detail: \.detail)
            observationSection
            recordSection("Reports", systemImage: "doc.text.fill", items: model.records.reports,
                          title: \.display, subtitle: { HealthFormat.date($0.issuedAt ?? $0.recordedAt) }, detail: \.detail)
            recordSection("Allergies", systemImage: "allergens.fill", items: model.records.allergies,
                          title: \.substance, subtitle: { $0.reaction }, detail: \.detail)
        }
    }

    // Observations get a richer row (value + abnormal flag), so it has its own section.
    @ViewBuilder
    private var observationSection: some View {
        if !model.records.observations.isEmpty {
            Section {
                ForEach(model.records.observations) { obs in
                    NavigationLink(value: obs.detail) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(obs.display)
                                Text(HealthFormat.date(obs.effectiveAt ?? obs.recordedAt))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(obs.valueText)
                                .font(.callout.weight(.medium))
                                .foregroundStyle(obs.isAbnormal ? .orange : .primary)
                        }
                    }
                }
            } header: {
                Label("Lab results & vitals", systemImage: "waveform.path.ecg")
            }
        }
    }

    /// Generic section for a record type that renders as title + optional subtitle rows.
    @ViewBuilder
    private func recordSection<T: Identifiable & Hashable>(
        _ name: String,
        systemImage: String,
        items: [T],
        title: @escaping (T) -> String,
        subtitle: @escaping (T) -> String?,
        detail: @escaping (T) -> RecordDetail
    ) -> some View {
        if !items.isEmpty {
            Section {
                ForEach(items) { item in
                    NavigationLink(value: detail(item)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title(item))
                            if let sub = subtitle(item), !sub.isEmpty {
                                Text(sub).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Label(name, systemImage: systemImage)
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No records yet", systemImage: "heart.text.square")
        } description: {
            Text("Add a lab result or connect a data source to start building your health timeline.")
        } actions: {
            Button("Add a record", systemImage: "plus") { showUpload = true }
                .buttonStyle(.borderedProminent)
        }
    }
}
