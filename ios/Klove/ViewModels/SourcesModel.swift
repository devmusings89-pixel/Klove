import Foundation

/// Connect / disconnect / track health-data sources. Shared by onboarding and Settings.
@MainActor
@Observable
final class SourcesModel {
    /// Per-source connection progress.
    enum SourceState: Equatable {
        case idle, connecting, connected, failed(String)
    }

    var sourceStates: [SourceType: SourceState] = [:]
    var connections: [SourceConnection] = []

    /// Human-readable result of the most recent connect/scan (e.g. "Scanned 12 emails, 3 new records").
    var lastScanMessage: String?

    /// When set, the view should open this OAuth URL (e.g. Gmail consent) and clear it afterward.
    var pendingAuthURL: URL?
    private var authInFlight: SourceType?

    private let api = APIClient()
    private let healthKit = HealthKitService()

    func state(for type: SourceType) -> SourceState { sourceStates[type] ?? .idle }
    var anyConnected: Bool { sourceStates.values.contains(.connected) }

    /// Email can be connected via Gmail (OAuth) or IMAP (iCloud/other) — the "Email" row reflects either.
    var isEmailConnected: Bool {
        state(for: .gmail) == .connected || state(for: .imap) == .connected ||
            connections.contains { ($0.type == "gmail" || $0.type == "imap") && $0.isConnected }
    }

    /// Connect a mailbox over IMAP (iCloud/Yahoo/Fastmail preset, or an explicit host).
    func connectIMAP(provider: String, host: String, username: String, password: String) async -> Bool {
        sourceStates[.imap] = .connecting
        var params = ["username": username, "password": password]
        if !provider.isEmpty { params["provider"] = provider }
        if !host.isEmpty { params["host"] = host }
        do {
            let resp = try await api.connectSource(.imap, params: params)
            sourceStates[.imap] = .connected
            lastScanMessage = scanSummary(scanned: resp.scanned, queued: resp.queued)
            await loadSources()
            return true
        } catch {
            sourceStates[.imap] = .failed(friendly(error, for: .imap))
            return false
        }
    }

    /// Re-scan a connected source on demand (Settings "Scan now"). Updates `lastScanMessage`.
    func scanNow(_ type: SourceType) async {
        do {
            let r = try await api.syncSource(type)
            lastScanMessage = scanSummary(scanned: r.scanned, queued: r.queued)
            await loadSources()
        } catch {
            lastScanMessage = friendly(error, for: type)
        }
    }

    private func scanSummary(scanned: Int?, queued: Int?) -> String {
        guard let scanned else { return "Connected — Klove will scan your mailbox shortly." }
        if scanned == 0 { return "Connected — no new health mail found yet. Klove keeps checking." }
        let q = queued ?? 0
        return "Scanned \(scanned) message\(scanned == 1 ? "" : "s") — \(q) new record\(q == 1 ? "" : "s") found."
    }

    func loadSources() async {
        guard let connections = try? await api.getSources() else { return }
        self.connections = connections
        for c in connections {
            guard let t = c.sourceType else { continue }
            if c.isConnected { sourceStates[t] = .connected }
            else if c.status == "revoked" { sourceStates[t] = .idle }
        }
    }

    func connect(_ type: SourceType) async {
        sourceStates[type] = .connecting
        do {
            switch type {
            case .healthkit:
                let granted = try await healthKit.requestAuthorization()
                guard granted else { sourceStates[type] = .failed("Health data isn't available on this device."); return }
                _ = try await api.connectSource(.healthkit)
                try? await healthKit.syncClinicalRecords() // best-effort initial pull
                sourceStates[type] = .connected
            case .gmail:
                let resp = try await api.connectSource(.gmail)
                if let urlString = resp.redirectUrl, let url = URL(string: urlString) {
                    authInFlight = type
                    pendingAuthURL = url // view opens it; finishAuth() is called on return
                } else {
                    sourceStates[type] = .connected
                }
            case .upload:
                // Upload needs no auth — registering the connection is enough; user uploads later.
                _ = try await api.connectSource(.upload)
                sourceStates[type] = .connected
            case .imap, .aggregator:
                _ = try await api.connectSource(type)
                sourceStates[type] = .connected
            }
        } catch {
            sourceStates[type] = .failed(friendly(error, for: type))
        }
    }

    func disconnect(_ type: SourceType) async {
        do {
            try await api.disconnectSource(type)
            sourceStates[type] = .idle
        } catch {
            sourceStates[type] = .failed(friendly(error, for: type))
        }
    }

    /// Called by the view after the OAuth web session returns.
    func finishAuth(success: Bool) {
        guard let type = authInFlight else { return }
        authInFlight = nil
        pendingAuthURL = nil
        sourceStates[type] = success ? .connected : .failed("Connection was cancelled.")
        if success { Task { await loadSources() } }
    }

    private func friendly(_ error: Error, for type: SourceType) -> String {
        let message = (error as? AppError)?.errorDescription ?? error.localizedDescription
        if message.contains("not_configured") {
            return "\(type.title) isn't available yet — you can connect it later."
        }
        return message
    }
}
