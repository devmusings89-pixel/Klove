import SwiftUI

/// Account, connected data sources, and legal. Sign out returns to onboarding.
struct SettingsView: View {
    @AppStorage(AppStorageKey.hasOnboarded) private var hasOnboarded = false
    @State private var sources = SourcesModel()
    @State private var pushEnabled = true
    @State private var reminderLead = 24
    private let api = APIClient()

    private var email: String { UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "—" }

    var body: some View {
        List {
            Section("Account") {
                LabeledContent("Signed in as", value: email)
                NavigationLink {
                    ProfileView()
                } label: {
                    Label("My Info & insurance", systemImage: "person.text.rectangle")
                }
            }

            Section {
                ConnectSourcesView(model: sources, types: sourceList, allowDisconnect: true)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            } header: {
                Text("Data sources")
            } footer: {
                Text("Connect more places Klove can pull your health data from.")
            }

            Section("Notifications") {
                Toggle("Push notifications", isOn: $pushEnabled)
                Picker("Remind me before visits", selection: $reminderLead) {
                    Text("1 hour").tag(1); Text("3 hours").tag(3); Text("1 day").tag(24); Text("2 days").tag(48)
                }
            }

            Section("About") {
                LabeledContent("Version", value: appVersion)
                Text("Klove surfaces information to discuss with your provider and is not a substitute for medical advice.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button("Sign out", role: .destructive, action: signOut)
            }
        }
        .navigationTitle("Settings")
        .task {
            await sources.loadSources()
            if let p = try? await api.getPreferences() { pushEnabled = p.pushEnabled; reminderLead = p.reminderLeadHours }
        }
        .onChange(of: pushEnabled) { Task { try? await api.updatePreferences(pushEnabled: pushEnabled, reminderLeadHours: reminderLead) } }
        .onChange(of: reminderLead) { Task { try? await api.updatePreferences(pushEnabled: pushEnabled, reminderLeadHours: reminderLead) } }
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
