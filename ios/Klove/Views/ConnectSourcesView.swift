import SwiftUI

/// Lists the health-data sources the user can connect. Reused in onboarding and Settings.
struct ConnectSourcesView: View {
    @Bindable var model: SourcesModel
    /// Which sources to show (onboarding shows the three primary ones; Settings can show all).
    var types: [SourceType] = SourceType.onboardingSources
    /// Settings allows disconnecting a connected source; onboarding does not.
    var allowDisconnect = false

    @State private var showEmailConnect = false

    var body: some View {
        VStack(spacing: 12) {
            ForEach(types) { type in
                SourceRow(
                    type: type,
                    state: displayState(type),
                    allowDisconnect: allowDisconnect,
                    onConnect: { connectAction(type) },
                    onManage: type == .gmail ? { showEmailConnect = true } : nil,
                    onDisconnect: { Task { await model.disconnect(type) } }
                )
            }
        }
        .sheet(isPresented: $showEmailConnect, onDismiss: { Task { await model.loadSources() } }) {
            EmailConnectView(model: model)
        }
    }

    // The "Email" row stands in for Gmail OR IMAP, so its state reflects either.
    private func displayState(_ type: SourceType) -> SourcesModel.SourceState {
        if type == .gmail, model.state(for: .gmail) != .connecting, model.isEmailConnected { return .connected }
        return model.state(for: type)
    }

    private func connectAction(_ type: SourceType) {
        if type == .gmail {
            showEmailConnect = true // email opens the Gmail/iCloud/IMAP chooser
        } else {
            Task { await model.connect(type) }
        }
    }
}

/// A single connectable source: icon, title/subtitle, and a trailing connect control.
private struct SourceRow: View {
    let type: SourceType
    let state: SourcesModel.SourceState
    let allowDisconnect: Bool
    let onConnect: () -> Void
    var onManage: (() -> Void)? = nil
    let onDisconnect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: type.systemImage)
                    .font(.title2)
                    .foregroundStyle(.tint)
                    .frame(width: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text(type.title).font(.headline)
                    Text(type.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()
                control
            }

            if case .failed(let message) = state {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Theme.needsYou)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder
    private var control: some View {
        switch state {
        case .connecting:
            ProgressView()
        case .connected:
            if let onManage {
                Button(action: onManage) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .font(.title3)
                }
            } else if allowDisconnect {
                Menu {
                    Button("Disconnect", systemImage: "minus.circle", role: .destructive, action: onDisconnect)
                } label: {
                    Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(.green)
                }
            } else {
                Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(.green)
            }
        case .idle, .failed:
            Button(state == .idle ? "Connect" : "Retry", action: onConnect)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
        }
    }
}
