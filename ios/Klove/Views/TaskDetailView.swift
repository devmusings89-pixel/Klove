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
                VStack(alignment: .leading, spacing: 8) {
                    Label(task.memberName ?? "You", systemImage: task.kindSymbol)
                        .font(.caption).foregroundStyle(Theme.accent)
                    Text(task.title).font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
                    if let detail = task.detail {
                        Text(detail).font(.body).foregroundStyle(Theme.inkSecondary)
                    }
                    statusPill
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .kloveCard()

                if task.isChooseTime, let slots = task.options, !slots.isEmpty, state == "needs_you" {
                    chooseTimes(slots)
                } else if state == "needs_you" { actions }
                else if state == "waiting" {
                    Text("Klove is handling this — you'll hear back when there's an update.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).kloveCard()
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Action")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var statusPill: some View {
        Text(state.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(pillColor, in: Capsule())
    }

    private var pillColor: Color {
        switch state { case "handled": return Theme.handled; case "waiting": return Theme.waiting; default: return Theme.needsYou }
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
}
