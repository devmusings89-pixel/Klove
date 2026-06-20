import SwiftUI

enum KloveTab: Hashable {
    case ask, today, family, records, actions

    init(name: String?) {
        switch name {
        case "today": self = .today
        case "family": self = .family
        case "records": self = .records
        case "actions": self = .actions
        default: self = .ask // the agent is home
        }
    }
}

/// The post-onboarding shell: Today (chief-of-staff briefing) · Family · Records · Actions, with a
/// persistent "Ask Klove" affordance floating above the tab bar (never a tab). Settings live behind
/// the operator avatar on Today.
struct MainTabView: View {
    @State private var selection = KloveTab(name: UserDefaults.standard.string(forKey: "initialTab"))
    @State private var store = HouseholdStore()
    @State private var showAsk = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            TabView(selection: $selection) {
                AskKloveView(inTab: true)
                    .tabItem { Label("Klove", systemImage: "sparkles") }
                    .tag(KloveTab.ask)

                NavigationStack { TodayView() }
                    .tabItem { Label("Today", systemImage: "house") }
                    .tag(KloveTab.today)

                NavigationStack { FamilyView() }
                    .tabItem { Label("Household", systemImage: "person.2") }
                    .tag(KloveTab.family)

                NavigationStack { RecordsView() }
                    .tabItem { Label("Records", systemImage: "doc.text") }
                    .tag(KloveTab.records)

                NavigationStack { ActionsView() }
                    .tabItem { Label("Actions", systemImage: "checklist") }
                    .tag(KloveTab.actions)
            }
            .tint(Theme.accent)

            // Quick-open Ask from the other tabs; redundant on the Klove tab itself.
            if selection != .ask {
                AskKloveButton { showAsk = true }
                    .padding(.trailing, 18)
                    .padding(.bottom, 58)
                    .accessibilityLabel("Ask Klove")
            }
        }
        .environment(store)
        .task {
            await store.load()
            await CapabilityStore.shared.refresh()   // learn which subsystems are live vs simulated
            PushManager.register()   // ask for notifications + register the APNs token
        }
        .onReceive(NotificationCenter.default.publisher(for: .kloveDeepLink)) { note in
            // A tapped push asked us to deep-link to a tab; refresh so the new task/appointment shows.
            if let tab = note.userInfo?["tab"] as? String {
                selection = KloveTab(name: tab)
                store.bumpData()
            }
        }
        .sheet(isPresented: $showAsk) {
            AskKloveView().environment(store)
        }
    }
}

/// The "Ask Klove" affordance — a circular ink FAB floating above the tab bar (never a tab), matching
/// every V1 screen. The sparkles glyph reads as the assistant you talk to, distinct from the explicit
/// action buttons on each task.
struct AskKloveButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "sparkles")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(Theme.background)
                .frame(width: 58, height: 58)
                .background(Theme.accent, in: Circle())
                .shadow(color: .black.opacity(0.22), radius: 10, x: 0, y: 4)
        }
    }
}
