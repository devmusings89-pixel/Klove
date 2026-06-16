import SwiftUI

/// Connect a mailbox so Klove can scan it for health records and appointments.
/// Gmail uses OAuth; iCloud / Yahoo / Fastmail / other use IMAP with an app-specific password.
struct EmailConnectView: View {
    @Bindable var model: SourcesModel
    @Environment(\.dismiss) private var dismiss
    @State private var webAuth = WebAuthCoordinator()

    @State private var provider = "icloud"
    @State private var emailAddress = ""
    @State private var password = ""
    @State private var customHost = ""
    @State private var connecting = false
    @State private var errorMessage: String?

    private let providers: [(id: String, name: String)] = [
        ("icloud", "iCloud"), ("yahoo", "Yahoo"), ("fastmail", "Fastmail"), ("other", "Other (IMAP)"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        Task { await model.connect(.gmail) }
                    } label: {
                        HStack {
                            Image(systemName: "envelope.fill")
                            Text("Continue with Gmail")
                            Spacer()
                            if model.state(for: .gmail) == .connecting { ProgressView() }
                            else if model.state(for: .gmail) == .connected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                        }
                    }
                } header: {
                    Text("Gmail")
                } footer: {
                    Text("Opens Google sign-in. Klove requests read-only access and only ingests health-related mail.")
                }

                Section {
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
                } header: {
                    Text("iCloud & other (IMAP)")
                } footer: {
                    Text("Use an app-specific password — for iCloud, create one at appleid.apple.com. Klove never sees your main password.")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Connect email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .onChange(of: model.pendingAuthURL) { _, url in
                guard let url else { return }
                Task {
                    let ok = await webAuth.start(url: url, callbackScheme: "klove")
                    model.finishAuth(success: ok)
                    if ok { dismiss() }
                }
            }
            .onChange(of: model.isEmailConnected) { _, connected in
                if connected { dismiss() }
            }
        }
    }

    private func connectIMAP() {
        connecting = true
        errorMessage = nil
        Task {
            let ok = await model.connectIMAP(provider: provider, host: customHost, username: emailAddress, password: password)
            connecting = false
            if ok { dismiss() } else if case .failed(let msg) = model.state(for: .imap) { errorMessage = msg }
        }
    }
}
