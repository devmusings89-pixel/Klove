import SwiftUI

/// The full action log behind the Today briefing: every task Klove is handling, grouped by status.
/// You can also start a new appointment booking here (the "+" / empty-state button).
struct ActionsView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var tasks: [KloveTask] = []
    @State private var loading = true
    @State private var showBook = false
    private let api = APIClient()

    private var needsYou: [KloveTask] { tasks.filter { $0.state == "needs_you" } }
    private var waiting: [KloveTask] { tasks.filter { $0.state == "waiting" } }
    private var handled: [KloveTask] { tasks.filter { $0.state == "handled" } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if loading && tasks.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if tasks.isEmpty {
                    empty
                } else {
                    group("Needs you", needsYou, Theme.needsYou, actionable: true)
                    group("Waiting on provider", waiting, Theme.waiting)
                    group("Handled", handled, Theme.handled)
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
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

    @ViewBuilder private func group(_ title: String, _ items: [KloveTask], _ tint: Color, actionable: Bool = false) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.headline).foregroundStyle(tint)
                ForEach(items) { task in
                    if actionable && !task.isChooseTime {
                        ActionableTaskCard(task: task, tint: tint,
                                           onDone: { Task { _ = try? await api.updateTask(task.id, state: "handled"); await load() } },
                                           onDelegate: { Task { _ = try? await api.routeTaskToConcierge(task.id); await load() } })
                    } else {
                        NavigationLink(value: task) { TaskCard(task: task) }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image(systemName: "checklist").font(.system(size: 40)).foregroundStyle(Theme.accent).padding(.top, 60)
            Text("No actions yet").font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
            Text("As Klove coordinates your family's care, tasks show up here. Need something now? Start by booking a visit.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.horizontal, 32)
            Button { showBook = true } label: {
                Label("Book an appointment", systemImage: "calendar.badge.plus")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(Theme.accent, in: Capsule())
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
    }
}
