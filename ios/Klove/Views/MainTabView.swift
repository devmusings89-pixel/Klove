import SwiftUI

enum KloveTab: Hashable {
    case today, family, records, actions

    init(name: String?) {
        switch name {
        case "family": self = .family
        case "records": self = .records
        case "actions": self = .actions
        default: self = .today
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
                NavigationStack { TodayView() }
                    .tabItem { Label("Today", systemImage: "sun.max.fill") }
                    .tag(KloveTab.today)

                NavigationStack { FamilyView() }
                    .tabItem { Label("Family", systemImage: "person.2.fill") }
                    .tag(KloveTab.family)

                NavigationStack { RecordsView() }
                    .tabItem { Label("Records", systemImage: "list.bullet.clipboard.fill") }
                    .tag(KloveTab.records)

                NavigationStack { ActionsView() }
                    .tabItem { Label("Actions", systemImage: "checklist") }
                    .tag(KloveTab.actions)
            }
            .tint(Theme.accent)

            AskKloveButton { showAsk = true }
                .padding(.trailing, 18)
                .padding(.bottom, 60)
                .accessibilityLabel("Ask Klove")
        }
        .environment(store)
        .task {
            await store.load()
            PushManager.register()   // ask for notifications + register the APNs token
        }
        .sheet(isPresented: $showAsk) {
            AskKloveView().environment(store)
        }
    }
}

/// The "Ask Klove" affordance — a labeled pill (not a bare button) so it reads as the assistant you
/// talk to, distinct from the explicit action buttons on each task.
struct AskKloveButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.system(size: 15, weight: .semibold))
                Text("Ask Klove").font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(Theme.accent, in: Capsule())
            .shadow(color: Theme.accent.opacity(0.35), radius: 10, x: 0, y: 4)
        }
    }
}
