import SwiftUI

/// The full action log behind the Today briefing: every task Klove is handling, grouped by status.
/// You can also start a new appointment booking here (the "+" / empty-state button).
struct ActionsView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var tasks: [KloveTask] = []
    @State private var loading = true
    @State private var showBook = false
    @State private var segment = 0   // 0 = Active, 1 = Done
    private let api = APIClient()

    private var needsYou: [KloveTask] { tasks.filter { $0.state == "needs_you" } }
    private var waiting: [KloveTask] { tasks.filter { $0.state == "waiting" } }
    private var handled: [KloveTask] { tasks.filter { $0.state == "handled" } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                ledgerHeader
                if loading && tasks.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if tasks.isEmpty {
                    empty
                } else if segment == 0 {
                    group("Needs you", needsYou)
                    group("Waiting on provider", waiting)
                    if needsYou.isEmpty && waiting.isEmpty { allClear }
                } else {
                    group("Handled", handled)
                    if handled.isEmpty { allClear }
                }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .contentMargins(.bottom, 80, for: .scrollContent)
        .navigationTitle("Actions")
        .navigationDestination(for: KloveTask.self) { TaskDetailView(task: $0, onChange: { Task { await load() } }) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showBook = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Book an appointment")
            }
        }
        .sheet(isPresented: $showBook) {
            if let m = store.selectedMember ?? store.actionableMembers.first {
                BookAppointmentView(memberId: m.userId, memberName: m.name, allowMemberChange: true,
                                    onBooked: { Task { await load() } })
                    .environment(store)
            } else {
                Text("Add a family member first.").padding()
            }
        }
        .task { await load(); if store.members.isEmpty { await store.load() } }
        .refreshable { await load() }
        .onChange(of: store.dataVersion) { Task { await load() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        tasks = (try? await api.getTasks()) ?? []
    }

    private var ledgerHeader: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            Text("Klove's ledger · everything we're tracking".uppercased())
                .font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
            KloveSegmentedControl(segments: ["Active", "Done"], selection: $segment)
        }
    }

    @ViewBuilder private func group(_ title: String, _ items: [KloveTask]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel(title: title, count: items.count)
                ForEach(items) { task in
                    NavigationLink(value: task) { TaskCard(task: task) }.buttonStyle(.plain)
                }
            }
        }
    }

    private var allClear: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(segment == 0 ? "Nothing active" : "Nothing here yet")
                .font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Text(segment == 0 ? "Klove isn't waiting on anything right now."
                              : "Completed tasks will collect here.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image(systemName: "checklist").font(.system(size: 40)).foregroundStyle(Theme.ink).padding(.top, 60)
            Text("No actions yet").font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Text("As Klove coordinates your family's care, tasks show up here. Need something now? Start by booking a visit.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.horizontal, 32)
            Button { showBook = true } label: {
                Label("Book an appointment", systemImage: "calendar.badge.plus")
            }
            .buttonStyle(KlovePrimaryButtonStyle())
            .padding(.horizontal, 40).padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
    }
}
