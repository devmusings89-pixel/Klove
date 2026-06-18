import SwiftUI

/// Account, connected data sources, and legal. Sign out returns to onboarding.
struct SettingsView: View {
    @AppStorage(AppStorageKey.hasOnboarded) private var hasOnboarded = false
    @State private var sources = SourcesModel()
    @State private var pushEnabled = true
    @State private var reminderLead = 24
    /// Last values the server confirmed, so we can revert the toggles when a write fails.
    @State private var lastSaved: (push: Bool, lead: Int) = (true, 24)
    /// Coalesces rapid changes into a single write (avoids the last-writer-wins race on every tap).
    @State private var saveTask: Task<Void, Never>?
    @State private var saveError: String?
    private let api = APIClient()

    private var email: String { UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "—" }

    var body: some View {
        List {
            Section {
                LabeledContent("Signed in as", value: email)
                NavigationLink {
                    ProfileView()
                } label: {
                    Label("My Info & insurance", systemImage: "person.text.rectangle")
                }
            } header: { sectionHeader("Account") }
            .listRowBackground(Theme.surface)

            Section {
                ConnectSourcesView(model: sources, types: sourceList, allowDisconnect: true)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            } header: {
                sectionHeader("Trust & data")
            } footer: {
                Text("Connect more places Klove can pull your health data from.")
            }

            Section {
                Label { Toggle("Push notifications", isOn: $pushEnabled) } icon: { Image(systemName: "bell") }
                Picker(selection: $reminderLead) {
                    Text("1 hour").tag(1); Text("3 hours").tag(3); Text("1 day").tag(24); Text("2 days").tag(48)
                } label: { Label("Remind me before visits", systemImage: "clock") }
            } header: {
                sectionHeader("Notifications")
            } footer: {
                if let saveError { Text(saveError).foregroundStyle(.red) }
            }
            .listRowBackground(Theme.surface)

            Section {
                LabeledContent { Text(appVersion) } label: { Label("Version", systemImage: "info.circle") }
                Text("Klove surfaces information to discuss with your provider and is not a substitute for medical advice.")
                    .font(.kloveCaption)
                    .foregroundStyle(Theme.inkSecondary)
            } header: { sectionHeader("Support") }
            .listRowBackground(Theme.surface)

            Section {
                Button("Sign out", role: .destructive, action: signOut)
            }
            .listRowBackground(Theme.surface)
        }
        .scrollContentBackground(.hidden)
        .kloveBackground()
        .tint(Theme.accent)
        .navigationTitle("Account")
        .task {
            await sources.loadSources()
            if let p = try? await api.getPreferences() {
                pushEnabled = p.pushEnabled
                reminderLead = p.reminderLeadHours
                lastSaved = (p.pushEnabled, p.reminderLeadHours)
            }
        }
        .onChange(of: pushEnabled) { scheduleSave() }
        .onChange(of: reminderLead) { scheduleSave() }
    }

    /// Debounce preference writes (~600ms) and coalesce push + lead into one request. On failure we
    /// surface the error and revert the toggles to the last server-confirmed values rather than
    /// silently dropping the change (the old `try?`-on-every-keystroke behavior).
    private func scheduleSave() {
        // Skip echoes from our own revert / initial load.
        guard pushEnabled != lastSaved.push || reminderLead != lastSaved.lead else { return }
        saveError = nil
        saveTask?.cancel()
        let push = pushEnabled
        let lead = reminderLead
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(600))
            if Task.isCancelled { return }
            do {
                let confirmed = try await api.updatePreferences(pushEnabled: push, reminderLeadHours: lead)
                lastSaved = (confirmed.pushEnabled, confirmed.reminderLeadHours)
            } catch {
                if Task.isCancelled { return }
                saveError = "Couldn't save your notification settings. Please try again."
                pushEnabled = lastSaved.push
                reminderLead = lastSaved.lead
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title).font(.kloveLabel).textCase(.uppercase).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
    }

    private var sourceList: [SourceType] { [.healthkit, .gmail, .upload, .aggregator] }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private func signOut() {
        AuthService.shared.signOut()
        hasOnboarded = false
    }
}
