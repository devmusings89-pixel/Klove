import SwiftUI

/// The unified appointment screen. One surface across the visit lifecycle — Upcoming · In visit ·
/// Past (the phase chip) — with a Brief / Discussion segmented control. Brief shows Klove's one-page
/// brief + logistics + the next actions (reschedule / cancel / log); Discussion holds the editable
/// questions and notes. Pulls the brief from the prep API, so it reuses the same data as visit prep.
struct AppointmentDetailView: View {
    let memberId: String
    let memberName: String
    let appt: UpcomingAppt
    var onChange: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var segment = 0   // 0 = Brief, 1 = Discussion
    @State private var brief: AppointmentBrief?
    @State private var questions: [String] = []
    @State private var notes = ""
    @State private var showReschedule = false
    @State private var newDate = Date().addingTimeInterval(86_400)
    @State private var showSummary = false
    @State private var confirmCancel = false
    @State private var working = false
    @State private var note: String?
    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                header
                KloveSegmentedControl(segments: ["Brief", "Discussion"], selection: $segment)
                if segment == 0 { briefTab } else { discussionTab }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Appointment")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showReschedule = true } label: { Label("Reschedule", systemImage: "calendar.badge.clock") }
                    if !appt.isProvisional {
                        Button { showSummary = true } label: { Label("Log visit summary", systemImage: "square.and.pencil") }
                    }
                    Button(role: .destructive) { confirmCancel = true } label: { Label("Cancel appointment", systemImage: "xmark.circle") }
                } label: { Image(systemName: "ellipsis") }
            }
        }
        .confirmationDialog("Cancel this appointment?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel appointment", role: .destructive) { Task { await cancel() } }
        }
        .sheet(isPresented: $showReschedule) { rescheduleSheet }
        .sheet(isPresented: $showSummary) {
            VisitSummaryView(memberId: memberId, memberName: memberName, appointmentId: appt.id)
        }
        .task { await loadPrep() }
    }

    // MARK: Header

    private var phase: (label: String, emphasized: Bool) {
        if appt.isProvisional { return ("Provisional", true) }
        guard let s = appt.startsAt, let d = ISO8601DateFormatter().date(from: s) else { return ("Upcoming", false) }
        if d < Date().addingTimeInterval(-2 * 3600) { return ("Past", false) }
        if d < Date() { return ("In visit", true) }
        return ("Upcoming", false)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text([memberName, "appointment"].joined(separator: "'s ").uppercased())
                    .font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
                Spacer()
                StatusChip(text: phase.label, emphasized: phase.emphasized)
            }
            Text(appt.title).font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            if let p = appt.provider {
                Text(p).font(.kloveBody).foregroundStyle(Theme.inkSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Brief tab

    private var briefTab: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
            if let note { Text(note).font(.kloveCaption).foregroundStyle(Theme.ink).kloveCardSunken() }

            // Status banner
            VStack(alignment: .leading, spacing: 4) {
                Label(appt.isProvisional ? "Provisional hold" : "Confirmed with the office",
                      systemImage: appt.isProvisional ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                    .font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                Text(appt.isProvisional
                     ? "Klove placed this time but hasn't confirmed it with the office yet."
                     : (appt.confirmation.map { "Confirmation \($0)" } ?? "You're all set."))
                    .font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .kloveCardSunken()

            if let b = brief { kloveBrief(b) }

            // Logistics
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel(title: "Logistics")
                logisticsRow("calendar", appt.whenDisplay)
                if let p = appt.provider { logisticsRow("stethoscope", p) }
                logisticsRow("person", "For \(memberName)")
                if let c = appt.confirmation, !c.isEmpty { logisticsRow("number", c) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .kloveCard()

            // Primary action by phase
            if appt.isProvisional || phase.label == "Upcoming" {
                Button { showReschedule = true } label: { Label("Reschedule", systemImage: "calendar.badge.clock") }
                    .buttonStyle(KlovePrimaryButtonStyle()).disabled(working)
            } else if phase.label == "Past" {
                Button { showSummary = true } label: { Label("Log visit summary", systemImage: "square.and.pencil") }
                    .buttonStyle(KlovePrimaryButtonStyle()).disabled(working)
            }
        }
    }

    private func kloveBrief(_ b: AppointmentBrief) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(title: "Klove's brief")
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if !b.summary.activeConditions.isEmpty {
                    briefRow("Conditions", b.summary.activeConditions.joined(separator: ", "))
                }
                if !b.summary.activeMedications.isEmpty {
                    briefRow("Medications", b.summary.activeMedications.joined(separator: ", "))
                }
                briefRow("On file", "\(b.summary.counts.observations) results · \(b.summary.counts.appointments) visits")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .kloveCard()
        }
    }

    private func logisticsRow(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.footnote).foregroundStyle(Theme.inkSecondary).frame(width: 20)
            Text(text).font(.kloveBody).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
        }
    }

    private func briefRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            Text(value).font(.kloveBody).foregroundStyle(Theme.ink)
        }
    }

    // MARK: Discussion tab

    private var discussionTab: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel(title: "Questions")
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    ForEach(questions.indices, id: \.self) { i in
                        HStack(alignment: .top, spacing: 8) {
                            Text("•").foregroundStyle(Theme.ink)
                            TextField("Question", text: $questions[i], axis: .vertical)
                                .font(.kloveBody).foregroundStyle(Theme.ink)
                            Button { questions.remove(at: i) } label: {
                                Image(systemName: "minus.circle").foregroundStyle(Theme.inkSecondary)
                            }
                        }
                    }
                    Button { questions.append("") } label: {
                        Label("Add a question", systemImage: "plus.circle").font(.kloveCaption).foregroundStyle(Theme.ink)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .kloveCard()
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel(title: "Notes")
                TextField("Add a note from the visit…", text: $notes, axis: .vertical)
                    .font(.kloveBody).foregroundStyle(Theme.ink).lineLimit(3...8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .kloveCard()
            }

            Button("Save questions") { Task { await saveQuestions() } }
                .buttonStyle(KlovePrimaryButtonStyle()).disabled(working)
        }
    }

    // MARK: Reschedule sheet

    private var rescheduleSheet: some View {
        NavigationStack {
            Form {
                DatePicker("New time", selection: $newDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
            }
            .navigationTitle("Reschedule").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showReschedule = false } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await reschedule() } } }
            }
            .tint(Theme.accent)
        }
    }

    // MARK: Data

    private func loadPrep() async {
        if let b = try? await api.getPrep(memberId, appointmentId: appt.id) {
            brief = b
            if questions.isEmpty { questions = b.questions }
        }
    }

    private func saveQuestions() async {
        working = true; defer { working = false }
        try? await api.saveQuestions(memberId, appointmentId: appt.id, questions: questions.filter { !$0.isEmpty })
        note = "Saved."
    }

    private func reschedule() async {
        working = true; defer { working = false }
        let iso = ISO8601DateFormatter().string(from: newDate)
        if (try? await api.rescheduleAppointment(memberId, appointmentId: appt.id, startsAt: iso)) != nil {
            showReschedule = false; note = "Rescheduled."; onChange()
        }
    }

    private func cancel() async {
        working = true; defer { working = false }
        if (try? await api.cancelAppointment(memberId, appointmentId: appt.id)) != nil { onChange(); dismiss() }
    }
}
