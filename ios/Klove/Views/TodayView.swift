import SwiftUI

/// The chief-of-staff briefing. What needs you, what's handled, what Klove is waiting on — one
/// clear next step at a time. Backed by GET /today (tasks + insights + upcoming visits).
struct TodayView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var briefing: TodayBriefing?
    @State private var loading = true
    @State private var showSettings = false
    @State private var showNotifications = false
    @State private var unread = 0

    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if loading && briefing == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if let b = briefing {
                    if b.needsYou.isEmpty { allHandledCard } else { section("Needs you", tasks: b.needsYou, tint: Theme.needsYou, actionable: true) }
                    if !b.upcomingAppointments.isEmpty { appointmentsCard(b.upcomingAppointments) }
                    if !b.waiting.isEmpty { section("Waiting on a provider", tasks: b.waiting, tint: Theme.waiting) }
                    if !b.handled.isEmpty { section("Recently handled", tasks: b.handled, tint: Theme.handled) }
                    watchingCard(b)
                } else {
                    ConnectionErrorView { Task { await load() } }
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Today")
        .navigationDestination(for: KloveTask.self) { TaskDetailView(task: $0, onChange: { Task { await load() } }) }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showNotifications = true } label: {
                    Image(systemName: unread > 0 ? "bell.badge.fill" : "bell")
                        .foregroundStyle(Theme.accent)
                }.accessibilityLabel("Notifications")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: {
                    Image(systemName: "person.crop.circle.fill").font(.title2).foregroundStyle(Theme.accent)
                }.accessibilityLabel("Settings")
            }
        }
        .sheet(isPresented: $showSettings) { NavigationStack { SettingsView() } }
        .sheet(isPresented: $showNotifications) { NotificationsInboxView(onRead: { Task { await loadUnread() } }) }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: store.dataVersion) { Task { await load() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        briefing = try? await api.getToday()
        await loadUnread()
    }

    private func loadUnread() async {
        unread = (try? await api.getNotifications().unread) ?? 0
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Good to see you").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            Text(store.household?.name ?? "Your family")
                .font(.system(.largeTitle, design: .serif).weight(.semibold))
                .foregroundStyle(Theme.ink)
        }
    }

    private var allHandledCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("All handled", systemImage: "checkmark.seal.fill").font(.headline).foregroundStyle(Theme.handled)
            Text("Nothing needs you right now. Klove is watching your family's care and will surface the one next step when something comes up.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func section(_ title: String, tasks: [KloveTask], tint: Color, actionable: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline).foregroundStyle(tint)
            ForEach(tasks) { task in
                if actionable && !task.isChooseTime {
                    ActionableTaskCard(task: task, tint: tint,
                                       onDone: { Task { await quickDone(task) } },
                                       onDelegate: { Task { await quickDelegate(task) } })
                } else {
                    NavigationLink(value: task) { TaskCard(task: task) }.buttonStyle(.plain)
                }
            }
        }
    }

    private func quickDone(_ task: KloveTask) async {
        _ = try? await api.updateTask(task.id, state: "handled")
        await load()
    }

    private func quickDelegate(_ task: KloveTask) async {
        _ = try? await api.routeTaskToConcierge(task.id)
        await load()
    }

    private func appointmentsCard(_ appts: [UpcomingAppt]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Upcoming visits", systemImage: "calendar").font(.headline).foregroundStyle(Theme.ink)
            ForEach(appts) { a in
                NavigationLink {
                    AppointmentDetailView(memberId: a.subjectUserId ?? "", memberName: a.memberName ?? "this member",
                                          appt: a, onChange: { Task { await load() } })
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                            Text([a.memberName, a.provider].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(Theme.inkSecondary)
                            if a.isProvisional {
                                Label("Provisional — not yet confirmed", systemImage: "exclamationmark.circle")
                                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.needsYou)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func watchingCard(_ b: TodayBriefing) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Who Klove is watching", systemImage: "eye").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            Text(b.members.map(\.name).joined(separator: " · ")).font(.subheadline).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }
}

struct TaskRow: View {
    let task: KloveTask
    let tint: Color

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: task.kindSymbol).foregroundStyle(tint).frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                if let m = task.memberName { Text(m).font(.caption).foregroundStyle(Theme.inkSecondary) }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        .kloveCard()
    }
}

/// A "Needs You" task card with explicit, obvious next-step buttons (distinct from the Ask Klove
/// assistant button): decide right here — do it yourself, or hand it to Klove.
struct ActionableTaskCard: View {
    let task: KloveTask
    let tint: Color
    var onDone: () -> Void
    var onDelegate: () -> Void
    @State private var working = false

    var body: some View {
        VStack(spacing: 12) {
            // Same structured body as every other card — with next-step buttons attached below.
            NavigationLink(value: task) { TaskCardBody(task: task) }
                .buttonStyle(.plain)

            // One clear next step: a single prominent action, with a quiet alternative beneath it.
            VStack(spacing: 8) {
                Button { working = true; onDelegate() } label: {
                    Label("Have Klove do it", systemImage: "sparkles")
                        .font(.kloveButton).frame(maxWidth: .infinity).padding(.vertical, 11)
                }
                .foregroundStyle(.white)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.Radius.sm))

                Button { working = true; onDone() } label: {
                    Text("I'll handle it — mark done")
                        .font(.kloveCaption.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .foregroundStyle(Theme.inkSecondary)
                .buttonStyle(.plain)
            }
            .disabled(working)
        }
        .kloveCard()
    }
}
