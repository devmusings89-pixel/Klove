import SwiftUI

/// Connect a mailbox so Klove can scan it for health records and appointments.
/// Primary path is Gmail OAuth (tap-to-consent, no password). Other providers (iCloud / Yahoo /
/// Fastmail) have no mail API, so they fall back to IMAP with an app-specific password — demoted
/// to an "Advanced" disclosure since it's not a flow most people will use.
struct EmailConnectView: View {
    @Bindable var model: SourcesModel
    @Environment(\.dismiss) private var dismiss
    @State private var webAuth = WebAuthCoordinator()

    @State private var provider = "icloud"
    @State private var emailAddress = ""
    @State private var password = ""
    @State private var customHost = ""
    @State private var connecting = false
    @State private var showAdvanced = false
    @State private var errorMessage: String?

    private let providers: [(id: String, name: String)] = [
        ("icloud", "iCloud"), ("yahoo", "Yahoo"), ("fastmail", "Fastmail"), ("other", "Other (IMAP)"),
    ]

    private var gmailState: SourcesModel.SourceState { model.state(for: .gmail) }

    var body: some View {
        NavigationStack {
            Form {
                gmailSection
                appleHealthHint
                advancedSection

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
                if let scan = model.lastScanMessage, errorMessage == nil {
                    Section {
                        Label(scan, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                }
            }
            .navigationTitle("Connect email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .onAppear { model.lastScanMessage = nil }
            .onChange(of: model.pendingAuthURL) { _, url in
                guard let url else { return }
                Task {
                    let ok = await webAuth.start(url: url, callbackScheme: "klove")
                    model.finishAuth(success: ok)
                    // On success, stay open briefly so the post-consent scan summary can appear.
                    if ok { await model.scanNow(.gmail) }
                }
            }
        }
    }

    // MARK: - Primary: Gmail (tap-to-consent)

    private var gmailSection: some View {
        Section {
            Button {
                Task { await model.connect(.gmail) }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "envelope.fill")
                    Text("Continue with Gmail").fontWeight(.semibold)
                    Spacer()
                    if gmailState == .connecting { ProgressView() }
                    else if gmailState == .connected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                    else { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
                }
            }
            .disabled(gmailState == .connecting)
        } header: {
            Text("Recommended")
        } footer: {
            Text("Opens Google sign-in — one tap, no password. Klove requests **read-only** access and only ingests health-related mail.")
        }
    }

    // MARK: - Apple users → HealthKit is the better path

    @ViewBuilder
    private var appleHealthHint: some View {
        Section {
            Label {
                Text("On iPhone? **Apple Health** syncs your labs, conditions, and medications with one tap — usually richer than email. Connect it from the Sources screen.")
                    .font(.footnote).foregroundStyle(.secondary)
            } icon: {
                Image(systemName: "heart.text.square.fill").foregroundStyle(.pink)
            }
        }
    }

    // MARK: - Advanced: other providers over IMAP (app-specific password)

    private var advancedSection: some View {
        Section {
            DisclosureGroup("Other providers (advanced)", isExpanded: $showAdvanced) {
                Picker("Provider", selection: $provider) {
                    ForEach(providers, id: \.id) { Text($0.name).tag($0.id) }
                }
                TextField("Email address", text: $emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("App-specific password", text: $password)
                if provider == "other" {
                    TextField("IMAP host (e.g. imap.example.com)", text: $customHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Button(action: connectIMAP) {
                    HStack {
                        Text("Connect mailbox")
                        Spacer()
                        if connecting { ProgressView() }
                    }
                }
                .disabled(connecting || emailAddress.isEmpty || password.isEmpty || (provider == "other" && customHost.isEmpty))
            }
        } footer: {
            Text("iCloud, Yahoo, and Fastmail don't offer a tap-to-connect option, so they need an **app-specific password** (not your main password). For iCloud, create one at appleid.apple.com → Sign-In & Security → App-Specific Passwords.")
        }
    }

    private func connectIMAP() {
        connecting = true
        errorMessage = nil
        Task {
            let ok = await model.connectIMAP(provider: provider, host: customHost, username: emailAddress, password: password)
            connecting = false
            // On success, stay open and show the scan summary (model.lastScanMessage); the user taps Done.
            if !ok, case .failed(let msg) = model.state(for: .imap) { errorMessage = msg }
        }
    }
}
