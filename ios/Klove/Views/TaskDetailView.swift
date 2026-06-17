import SwiftUI

/// One task: what's happening, why it matters, and the next step. Approve/handle it yourself, or
/// hand it to the concierge. Every screen answers What · Why · What next.
struct TaskDetailView: View {
    let task: KloveTask
    var onChange: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var state: String
    private let api = APIClient()

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

                // Show the live call card except on a choose-time task, where the time picker below
                // is the relevant surface and the card would just duplicate it.
                if let jobId = task.conciergeJobId, !task.isChooseTime { SessionLiveCard(sessionId: jobId) }

                if task.isChooseTime, let slots = task.options, !slots.isEmpty, state == "needs_you" {
                    chooseTimes(slots)
                } else if state == "needs_you" { actions }
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
            Button { Task { await handle() } } label: {
                Label("Mark handled", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .foregroundStyle(.white).background(Theme.handled, in: RoundedRectangle(cornerRadius: 12)).disabled(working)

            Button { Task { await route() } } label: {
                Label("Have Klove handle it", systemImage: "sparkles")
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .foregroundStyle(.white).background(Theme.accent, in: RoundedRectangle(cornerRadius: 12)).disabled(working)

            // The spec's third choice: do it now, hand to Klove, or snooze it out of the way.
            Menu {
                Button("3 days") { Task { await snooze(3) } }
                Button("1 week") { Task { await snooze(7) } }
                Button("2 weeks") { Task { await snooze(14) } }
            } label: {
                Label("Snooze", systemImage: "clock.arrow.circlepath")
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .foregroundStyle(Theme.ink).background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 12)).disabled(working)
        }
    }

    private func handle() async {
        working = true; defer { working = false }
        if (try? await api.updateTask(task.id, state: "handled")) != nil { state = "handled"; onChange(); dismiss() }
    }

    private func route() async {
        working = true; defer { working = false }
        if (try? await api.routeTaskToConcierge(task.id)) != nil { state = "waiting"; onChange(); dismiss() }
    }

    private func snooze(_ days: Int) async {
        working = true; defer { working = false }
        if (try? await api.snoozeTask(task.id, days: days)) != nil { onChange(); dismiss() }
    }
}
