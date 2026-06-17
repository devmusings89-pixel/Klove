import SwiftUI

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
    @State private var errorMessage: String?
    @State private var pendingDoseId: String?
    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
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
        .navigationTitle("Medications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { med in
            ScheduleEditor(med: med) { times, critical in
                await save(med: med, times: times, critical: critical)
            }
        }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(errorMessage ?? "") }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("No medications yet", systemImage: "pills").font(.headline).foregroundStyle(Theme.ink)
            Text("Medications appear here as Klove reads \(memberName)'s records. Add a dosing schedule to get dose reminders and a heads-up if a dose is missed.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
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
                Button(med.schedule == nil ? "Add schedule" : "Edit") { editing = med }
                    .font(.caption.weight(.semibold)).tint(Theme.accent)
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
                        Text("Mark taken").font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Theme.accent, in: Capsule()).foregroundStyle(.white)
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
        do { _ = try await api.setDoseStatus(dose.id, status: status); await load() }
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
