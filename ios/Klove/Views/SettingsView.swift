import SwiftUI

/// Account, connected data sources, and legal. Sign out returns to onboarding.
struct SettingsView: View {
    @AppStorage(AppStorageKey.hasOnboarded) private var hasOnboarded = false
    @State private var sources = SourcesModel()

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
        .task { await sources.loadSources() }
    }

    private var sourceList: [SourceType] { [.healthkit, .gmail, .upload, .aggregator] }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private func signOut() {
        UserDefaults.standard.removeObject(forKey: AppStorageKey.userEmail)
        hasOnboarded = false
    }
}
