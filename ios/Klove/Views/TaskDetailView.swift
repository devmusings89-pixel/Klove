import SwiftUI

/// One task: what's happening, why it matters, and the next step. Approve/handle it yourself, or
/// hand it to the concierge. Every screen answers What · Why · What next.
struct TaskDetailView: View {
    let task: KloveTask
    var onChange: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var state: String
    @State private var showBooking = false
    @State private var upcoming: [UpcomingAppt] = []
    @State private var pickingAppointment = false
    private let api = APIClient()

    /// Show the borderline-insight choices instead of a concierge handoff or the old
    /// "Klove is handling this" placeholder, for a health insight not already in a live job.
    private var showInsightChoices: Bool {
        task.isInsight && task.conciergeJobId == nil && !task.isChooseTime
            && (state == "needs_you" || state == "waiting")
    }

    init(task: KloveTask, onChange: @escaping () -> Void = {}) {
        self.task = task
        self.onChange = onChange
        _state = State(initialValue: task.state)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // The same canonical card shown on Today / Actions — consistent across entry points.
                TaskCard(task: task)

                // Show the live call card only while a job is genuinely in flight (state == waiting).
                // A needs_you task never has a live job — reconcile clears the link when a job
                // dead-ends — so this also prevents the stale "Klove is starting the calls…" card the
                // old route-to-concierge dead-end produced. Choose-time uses the picker below instead.
                if let jobId = task.conciergeJobId, state == "waiting", !task.isChooseTime { SessionLiveCard(sessionId: jobId) }

                if task.isChooseTime, let slots = task.options, !slots.isEmpty, state == "needs_you" {
                    chooseTimes(slots)
                } else if showInsightChoices { insightChoices }
                else if state == "needs_you" { actions }
                else if state == "waiting", task.conciergeJobId == nil {
                    Text("Klove is handling this — you'll hear back when there's an update.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).kloveCard()
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Action")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) { Task { await dismissTask() } } label: { Image(systemName: "trash") }
                    .disabled(working)
            }
        }
        .sheet(isPresented: $showBooking) {
            BookAppointmentView(
                memberId: task.subjectUserId ?? "",
                memberName: task.memberName ?? "this member",
                initialReason: task.displayTitle
            ) { onChange(); dismiss() }
        }
        .confirmationDialog("Add to which visit?", isPresented: $pickingAppointment, titleVisibility: .visible) {
            ForEach(upcoming) { appt in
                Button(appt.whenDisplay + (appt.provider.map { " · \($0)" } ?? "")) {
                    Task { await attach(to: appt) }
                }
            }
        } message: {
            Text("We'll add this as a question to raise at the visit.")
        }
        .task {
            // Only insights need the upcoming-visit option; skip the fetch otherwise.
            guard showInsightChoices else { return }
            if let brief = try? await api.getToday() {
                upcoming = brief.upcomingAppointments.filter { $0.subjectUserId == task.subjectUserId }
            }
        }
    }

    private func dismissTask() async {
        working = true; defer { working = false }
        if (try? await api.deleteTask(task.id)) != nil { onChange(); dismiss() }
    }

    private func chooseTimes(_ slots: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pick a time the office offered").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            ForEach(slots, id: \.self) { slot in
                Button { Task { await choose(slot) } } label: {
                    HStack {
                        Image(systemName: "clock").foregroundStyle(Theme.accent)
                        Text(slot).foregroundStyle(Theme.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                    .padding(.vertical, 12).padding(.horizontal, 14)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                .disabled(working)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func choose(_ slot: String) async {
        working = true; defer { working = false }
        if (try? await api.chooseTaskSlot(task.id, slot: slot)) != nil { state = "waiting"; onChange(); dismiss() }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            // Primary next step for a booking that needs you: finish it — pick/add a provider and
            // confirm, then Klove places the calls. (Klove is the booking engine; there's no separate
            // human concierge to hand off to.)
            if task.kind == "book" {
                Button { showBooking = true } label: {
                    Label("Finish booking", systemImage: "phone.arrow.up.right")
                }
                .buttonStyle(KlovePrimaryButtonStyle()).disabled(working)
            }

            // Quiet alternative: do it yourself.
            Button { Task { await handle() } } label: {
                Label("I'll handle it — mark done", systemImage: "checkmark.circle")
                    .font(.kloveButton).foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
            }
            .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .buttonStyle(.plain).disabled(working)

            // The spec's third choice: do it now, hand to Klove, or snooze it out of the way.
            Menu {
                Button("3 days") { Task { await snooze(3) } }
                Button("1 week") { Task { await snooze(7) } }
                Button("2 weeks") { Task { await snooze(14) } }
            } label: {
                Label("Snooze", systemImage: "clock.arrow.circlepath")
                    .font(.kloveButton).foregroundStyle(Theme.inkSecondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .disabled(working)
        }
    }

    // Borderline health insight: frame it honestly and offer two real next steps — book a follow-up,
    // or add it as a question to a visit that's already on the calendar.
    private var insightChoices: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This is a borderline result — worth a closer look, but not urgent. How would you like to handle it?")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                .frame(maxWidth: .infinity, alignment: .leading).kloveCard()

            Button { Task { await bookFollowUp() } } label: {
                Label("Book a follow-up", systemImage: "calendar.badge.plus")
            }
            .buttonStyle(KlovePrimaryButtonStyle()).disabled(working)

            if !upcoming.isEmpty {
                Button { pickingAppointment = true } label: {
                    Label("Add as a question to an upcoming visit", systemImage: "text.bubble")
                        .font(.kloveButton).foregroundStyle(Theme.ink)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                }
                .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                .buttonStyle(.plain).disabled(working)
            } else {
                // No upcoming visit to ride on — nudge toward booking instead.
                Text("No upcoming visit to attach a question to — book a follow-up above.")
                    .font(.footnote).foregroundStyle(Theme.inkSecondary)
            }

            Menu {
                Button("3 days") { Task { await snooze(3) } }
                Button("1 week") { Task { await snooze(7) } }
                Button("2 weeks") { Task { await snooze(14) } }
            } label: {
                Label("Snooze", systemImage: "clock.arrow.circlepath")
                    .font(.kloveButton).foregroundStyle(Theme.inkSecondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .disabled(working)
        }
    }

    private func bookFollowUp() async {
        working = true; defer { working = false }
        // Convert the insight into a booking task, then open the normal booking flow.
        if (try? await api.bookFollowUp(task.id)) != nil { onChange(); showBooking = true }
    }

    private func attach(to appt: UpcomingAppt) async {
        working = true; defer { working = false }
        if (try? await api.attachQuestion(task.id, appointmentId: appt.id)) != nil { state = "handled"; onChange(); dismiss() }
    }

    private func handle() async {
        working = true; defer { working = false }
        if (try? await api.updateTask(task.id, state: "handled")) != nil { state = "handled"; onChange(); dismiss() }
    }

    private func snooze(_ days: Int) async {
        working = true; defer { working = false }
        if (try? await api.snoozeTask(task.id, days: days)) != nil { onChange(); dismiss() }
    }
}
