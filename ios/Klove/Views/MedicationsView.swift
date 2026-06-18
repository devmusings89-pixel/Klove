import SwiftUI
import UniformTypeIdentifiers

/// Medications for one member: today's doses with one-tap "mark taken", the dosing schedule, refill
/// status, and a 7-day adherence summary. Schedules drive dose reminders to the member and
/// missed-dose alerts to the caregiver (handled server-side).
struct MedicationsView: View {
    let memberId: String
    let memberName: String

    @State private var meds: [MemberMedication] = []
    @State private var adherence: Adherence?
    @State private var loading = true
    @State private var editing: MemberMedication?
    @State private var editingDetails: MemberMedication?
    @State private var addingMed = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?
    @State private var pendingDoseId: String?
    @State private var takenHaptic = 0
    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let infoMessage {
                    Label(infoMessage, systemImage: "checkmark.circle")
                        .font(.caption).foregroundStyle(Theme.handled).kloveCard()
                }
                if loading && meds.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if meds.isEmpty {
                    emptyState
                } else {
                    if let a = adherence, a.total > 0 { adherenceCard(a) }
                    ForEach(meds) { medCard($0) }
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .contentMargins(.bottom, 80, for: .scrollContent)
        .sensoryFeedback(.success, trigger: takenHaptic)
        .navigationTitle("Medications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { addingMed = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add medication")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { med in
            ScheduleEditor(med: med) { times, critical in
                await save(med: med, times: times, critical: critical)
            }
        }
        .sheet(isPresented: $addingMed) {
            MedicationEditor(existing: nil, searchDrugs: { (try? await api.searchDrugs($0)) ?? [] },
                             resolveRxcui: { await api.resolveDrugRxcui($0) },
                             onSave: { body, times, critical in await addMed(body, times: times, critical: critical) },
                             onScan: { data, mime, name in await scan(data, mimeType: mime, filename: name) })
        }
        .sheet(item: $editingDetails) { med in
            MedicationEditor(existing: med, searchDrugs: { (try? await api.searchDrugs($0)) ?? [] },
                             resolveRxcui: { await api.resolveDrugRxcui($0) },
                             onSave: { body, _, _ in await editMed(med, body) },
                             onScan: nil)
        }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(errorMessage ?? "") }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("No medications yet", systemImage: "pills").font(.headline).foregroundStyle(Theme.ink)
            Text("Add \(memberName)'s medications below, or connect a source and Klove will read them from records. Set a dosing schedule to get dose reminders and a heads-up if a dose is missed.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
            Button { addingMed = true } label: {
                Label("Add medication", systemImage: "plus")
                    .font(.kloveButton).padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Theme.accent, in: Capsule()).foregroundStyle(Theme.background)
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func adherenceCard(_ a: Adherence) -> some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Last 7 days").font(.caption).foregroundStyle(Theme.inkSecondary)
                Text(a.ratePercent ?? "—").font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
                Text("doses taken on time").font(.caption2).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if a.missed > 0 { Text("\(a.missed) missed").font(.caption.weight(.semibold)).foregroundStyle(Theme.needsYou) }
                if a.taken > 0 { Text("\(a.taken) taken").font(.caption).foregroundStyle(Theme.handled) }
            }
        }
        .kloveCard()
    }

    private func medCard(_ med: MemberMedication) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(med.display).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    if let d = med.dosage { Text(d).font(.caption).foregroundStyle(Theme.inkSecondary) }
                }
                Spacer()
                Button(med.schedule == nil ? "Add schedule" : "Edit schedule") { editing = med }
                    .font(.caption.weight(.semibold)).tint(Theme.accent)
                Menu {
                    Button("Edit details", systemImage: "pencil") { editingDetails = med }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(Theme.inkSecondary)
                }
            }

            if let sched = med.schedule, !sched.times.isEmpty {
                HStack(spacing: 6) {
                    Label("Daily at \(sched.times.map(Self.pretty).joined(separator: ", "))", systemImage: "clock")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                    if sched.critical {
                        Text("Critical").font(.caption2.weight(.bold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.needsYou.opacity(0.15), in: Capsule()).foregroundStyle(Theme.needsYou)
                    }
                }
            }

            if let refill = med.refillDisplay {
                Label("Refill due \(refill)" + (med.refillsRemaining.map { " · \($0) left" } ?? ""), systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(Theme.inkSecondary)
            }

            if let a = med.adherence7d, a.missed > 0 {
                Label("\(a.missed) missed in the last 7 days", systemImage: "exclamationmark.circle")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.needsYou)
            }

            if !med.todaysDoses.isEmpty {
                Divider()
                Text("Today").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
                ForEach(med.todaysDoses) { doseRow($0) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func doseRow(_ dose: Dose) -> some View {
        HStack {
            Image(systemName: doseIcon(dose.status)).foregroundStyle(doseTint(dose.status))
            Text(dose.timeDisplay).font(.subheadline).foregroundStyle(Theme.ink)
            if dose.status == "skipped" { Text("Skipped").font(.caption).foregroundStyle(Theme.inkSecondary) }
            Spacer()
            switch dose.status {
            case "taken":
                // Tap to undo a fat-finger "taken".
                Menu {
                    Button("Undo — mark not taken") { Task { await setStatus(dose, "pending") } }
                } label: {
                    Label("Taken", systemImage: "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(Theme.handled)
                }
            default:
                HStack(spacing: 8) {
                    Button { Task { await setStatus(dose, "taken") } } label: {
                        Text("Mark taken").font(.kloveButton)
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Theme.accent, in: Capsule()).foregroundStyle(Theme.background)
                    }
                    .disabled(pendingDoseId == dose.id)
                    Menu {
                        Button("Skip this dose") { Task { await setStatus(dose, "skipped") } }
                    } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Theme.inkSecondary) }
                }
            }
        }
    }

    private func doseIcon(_ s: String) -> String {
        switch s {
        case "taken": return "checkmark.circle.fill"
        case "missed": return "exclamationmark.circle.fill"
        case "skipped": return "minus.circle"
        default: return "circle"
        }
    }
    private func doseTint(_ s: String) -> Color {
        switch s { case "taken": return Theme.handled; case "missed": return Theme.needsYou; default: return Theme.inkSecondary }
    }

    private func load() async {
        loading = true; defer { loading = false }
        meds = (try? await api.memberMedications(memberId)) ?? []
        adherence = try? await api.memberAdherence(memberId)
    }

    private func setStatus(_ dose: Dose, _ status: String) async {
        pendingDoseId = dose.id; defer { pendingDoseId = nil }
        do {
            _ = try await api.setDoseStatus(dose.id, status: status)
            if status == "taken" { takenHaptic += 1 }
            await load()
        }
        catch { errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription }
    }

    private func save(med: MemberMedication, times: [String], critical: Bool) async {
        do {
            if times.isEmpty { _ = try await api.clearMedicationSchedule(med.id) }
            else { _ = try await api.setMedicationSchedule(med.id, times: times, critical: critical) }
            await load()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Manually add a medication, optionally setting its dosing schedule in the same step.
    private func addMed(_ body: MedicationBody, times: [String], critical: Bool) async {
        do {
            let created = try await api.addMedication(memberId, body)
            if !times.isEmpty { _ = try await api.setMedicationSchedule(created.id, times: times, critical: critical) }
            await load()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Edit an existing medication's details (works on extracted meds too).
    private func editMed(_ med: MemberMedication, _ body: MedicationBody) async {
        do {
            _ = try await api.updateMedication(med.id, body)
            await load()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Upload a snapped/picked prescription; extraction runs server-side and the med appears shortly.
    private func scan(_ data: Data, mimeType: String, filename: String) async {
        do {
            _ = try await api.uploadForMember(memberId, data: data, mimeType: mimeType, filename: filename)
            infoMessage = "Reading the prescription — \(memberName)'s medication will appear here shortly. Pull to refresh."
            await load()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// "08:00" → "8:00 AM" for display.
    static func pretty(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return hhmm }
        var c = DateComponents(); c.hour = h; c.minute = m
        guard let date = Calendar.current.date(from: c) else { return hhmm }
        let f = DateFormatter(); f.dateFormat = "h:mm a"
        return f.string(from: date)
    }
}

/// Edit a medication's dosing times (one daily reminder per time). Empty = stop reminders.
private struct ScheduleEditor: View {
    let med: MemberMedication
    let onSave: ([String], Bool) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var times: [Date]
    @State private var critical: Bool
    @State private var saving = false

    init(med: MemberMedication, onSave: @escaping ([String], Bool) async -> Void) {
        self.med = med
        self.onSave = onSave
        let cal = Calendar.current
        let initial = (med.schedule?.times ?? ["08:00"]).compactMap { hhmm -> Date? in
            let p = hhmm.split(separator: ":"); guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]) else { return nil }
            return cal.date(from: DateComponents(hour: h, minute: m))
        }
        _times = State(initialValue: initial.isEmpty ? [cal.date(from: DateComponents(hour: 8, minute: 0))!] : initial)
        _critical = State(initialValue: med.schedule?.critical ?? false)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(times.indices, id: \.self) { i in
                        DatePicker("Dose \(i + 1)", selection: $times[i], displayedComponents: .hourAndMinute)
                    }
                    .onDelete { times.remove(atOffsets: $0) }
                    Button("Add a time", systemImage: "plus") {
                        times.append(Calendar.current.date(from: DateComponents(hour: 12, minute: 0))!)
                    }
                } header: {
                    Text(med.display)
                } footer: {
                    Text("\(med.display.components(separatedBy: " ").first ?? "This medication") will remind the member at each time, and alert you if a dose isn't logged.")
                }

                Section {
                    Toggle("Critical medication", isOn: $critical)
                } footer: {
                    Text("Critical meds (e.g. insulin, blood thinners) send a stronger missed-dose alert that bypasses your quiet-notification setting and shows up in Today.")
                }
            }
            .navigationTitle("Dosing schedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await commit() } }.disabled(saving)
                }
                ToolbarItem(placement: .topBarLeading) {
                    if med.schedule != nil {
                        Button("Stop", role: .destructive) { Task { await stop() } }.disabled(saving)
                    }
                }
            }
        }
    }

    private func commit() async {
        saving = true
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        let strings = times.map { f.string(from: $0) }.sorted()
        await onSave(strings, critical)
        dismiss()
    }

    private func stop() async {
        saving = true
        await onSave([], false)
        dismiss()
    }
}

/// Add a medication manually (with drug-name autocomplete and an optional "scan a prescription"
/// shortcut), or edit an existing one's details. When `existing` is nil this is an add form: it can
/// also set the dosing schedule in the same step. When editing, the schedule lives in ScheduleEditor.
private struct MedicationEditor: View {
    let existing: MemberMedication?
    let searchDrugs: (String) async -> [DrugSuggestion]
    let resolveRxcui: (String) async -> String?
    let onSave: (MedicationBody, [String], Bool) async -> Void
    /// Upload a picked/snapped prescription (add mode only). nil hides the scan section.
    let onScan: ((Data, String, String) async -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var rxNormCode: String?
    @State private var dosage: String
    @State private var frequency: String
    @State private var daysSupply: String
    @State private var refillsRemaining: String

    @State private var setSchedule = false
    @State private var times: [Date] = [Calendar.current.date(from: DateComponents(hour: 8, minute: 0))!]
    @State private var critical = false

    @State private var suggestions: [DrugSuggestion] = []
    @State private var searchTask: Task<Void, Never>?
    @State private var suppressSearch = false
    @State private var saving = false

    @State private var showFileImporter = false
    @State private var showCamera = false

    private var isEdit: Bool { existing != nil }

    init(existing: MemberMedication?,
         searchDrugs: @escaping (String) async -> [DrugSuggestion],
         resolveRxcui: @escaping (String) async -> String?,
         onSave: @escaping (MedicationBody, [String], Bool) async -> Void,
         onScan: ((Data, String, String) async -> Void)?) {
        self.existing = existing
        self.searchDrugs = searchDrugs
        self.resolveRxcui = resolveRxcui
        self.onSave = onSave
        self.onScan = onScan
        _name = State(initialValue: existing?.display ?? "")
        _dosage = State(initialValue: existing?.dosage ?? "")
        _frequency = State(initialValue: "")
        _daysSupply = State(initialValue: "")
        _refillsRemaining = State(initialValue: existing?.refillsRemaining.map(String.init) ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Medication name", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                    ForEach(suggestions) { s in
                        Button { select(s) } label: {
                            HStack {
                                Text(s.name).font(.subheadline).foregroundStyle(Theme.ink)
                                Spacer()
                                Image(systemName: "plus.circle").foregroundStyle(Theme.accent)
                            }
                        }
                    }
                } header: {
                    Text("Medication")
                } footer: {
                    Text("Start typing to search a drug database, or enter the name as written on the bottle.")
                }

                Section {
                    TextField("Dosage (e.g. 500mg twice daily)", text: $dosage)
                    TextField("Frequency (e.g. once daily)", text: $frequency)
                    TextField("Days supply (e.g. 30)", text: $daysSupply).keyboardType(.numberPad)
                    TextField("Refills remaining", text: $refillsRemaining).keyboardType(.numberPad)
                } header: {
                    Text("Details")
                }

                if !isEdit {
                    Section {
                        Toggle("Set dosing schedule now", isOn: $setSchedule)
                        if setSchedule {
                            ForEach(times.indices, id: \.self) { i in
                                DatePicker("Dose \(i + 1)", selection: $times[i], displayedComponents: .hourAndMinute)
                            }
                            .onDelete { times.remove(atOffsets: $0) }
                            Button("Add a time", systemImage: "plus") {
                                times.append(Calendar.current.date(from: DateComponents(hour: 12, minute: 0))!)
                            }
                            Toggle("Critical medication", isOn: $critical)
                        }
                    } footer: {
                        if setSchedule {
                            Text("The member is reminded at each time, and you're alerted if a dose isn't logged. Critical meds send a stronger alert.")
                        }
                    }

                    if onScan != nil {
                        Section {
                            Button { showCamera = true } label: {
                                Label("Scan a prescription", systemImage: "doc.viewfinder")
                            }
                            Button { showFileImporter = true } label: {
                                Label("Upload a photo or PDF", systemImage: "doc")
                            }
                        } footer: {
                            Text("Klove reads the prescription and fills in the medication for you.")
                        }
                    }
                }
            }
            .navigationTitle(isEdit ? "Edit medication" : "Add medication")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await commit() } }
                        .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .sheet(isPresented: $showCamera) {
                CameraPicker { data in Task { await scan(data, "image/jpeg", "prescription.jpg") } }
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf, .image]) { result in
                guard case .success(let url) = result else { return }
                Task { await scanFile(url) }
            }
            .onChange(of: name) { _, _ in scheduleSearch() }
        }
    }

    private func select(_ s: DrugSuggestion) {
        suppressSearch = true
        name = s.name
        rxNormCode = nil
        suggestions = []
        searchTask?.cancel()
        // Resolve the RxNorm code in the background so selection stays instant.
        Task { rxNormCode = await resolveRxcui(s.term) }
    }

    private func scheduleSearch() {
        if suppressSearch { suppressSearch = false; return }
        rxNormCode = nil // typing invalidates a prior selection
        searchTask?.cancel()
        let q = name
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            let r = await searchDrugs(q)
            if Task.isCancelled { return }
            suggestions = r
        }
    }

    private func commit() async {
        saving = true
        var body = MedicationBody()
        body.display = name.trimmingCharacters(in: .whitespaces)
        body.dosage = dosage.isEmpty ? nil : dosage
        body.frequency = frequency.isEmpty ? nil : frequency
        body.daysSupply = Int(daysSupply)
        body.refillsRemaining = Int(refillsRemaining)
        body.rxNormCode = rxNormCode
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        let strings = (!isEdit && setSchedule) ? times.map { f.string(from: $0) }.sorted() : []
        await onSave(body, strings, critical)
        dismiss()
    }

    private func scan(_ data: Data, _ mime: String, _ filename: String) async {
        await onScan?(data, mime, filename)
        dismiss()
    }

    private func scanFile(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let isPDF = url.pathExtension.lowercased() == "pdf"
        await scan(data, isPDF ? "application/pdf" : "image/jpeg", url.lastPathComponent)
    }
}
