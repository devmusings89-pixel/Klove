import SwiftUI

/// Per-member connections manager: see what's connected, connect HealthX (records connector), or
/// capture a document. Apple Health on-device sync lands with Phase-5 entitlements.
struct MemberConnectView: View {
    let memberId: String
    let memberName: String

    @State private var sources: [SourceConnection] = []
    @State private var loading = true
    @State private var showCamera = false
    @State private var busy = false
    @State private var message: String?
    @State private var webAuth = WebAuthCoordinator()
    @Environment(\.openURL) private var openURL
    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let message {
                    Text(message).font(.caption).foregroundStyle(Theme.handled).kloveCard()
                }

                connectedSection
                addSection
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("\(memberName)'s connections")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(isPresented: $showCamera) {
            CameraPicker { data in Task { await upload(data) } }
        }
    }

    private var connectedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connected").font(.headline).foregroundStyle(Theme.ink)
            if sources.isEmpty {
                Text("No sources connected yet.").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            } else {
                ForEach(sources) { s in
                    HStack(spacing: 12) {
                        Image(systemName: s.sourceType?.systemImage ?? "link").foregroundStyle(Theme.accent).frame(width: 26)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.sourceType?.title ?? s.type).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                            Text(s.status.capitalized).font(.caption).foregroundStyle(Theme.inkSecondary)
                        }
                        Spacer()
                        if s.status != "revoked", let t = s.sourceType {
                            Button("Disconnect") { Task { await disconnect(t) } }
                                .font(.caption).foregroundStyle(.red)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a source").font(.headline).foregroundStyle(Theme.ink)
            connectRow(.aggregator, action: connectHealthX)
            connectRow(.gmail, action: connectEmail)
            Button { showCamera = true } label: {
                sourceRowLabel(icon: "doc.viewfinder.fill", title: "Scan a document", subtitle: "Snap a lab result or form for \(memberName).")
            }.buttonStyle(.plain).disabled(busy)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func connectRow(_ type: SourceType, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            sourceRowLabel(icon: type.systemImage, title: type.title, subtitle: type.subtitle)
        }.buttonStyle(.plain).disabled(busy)
    }

    private func sourceRowLabel(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(Theme.accent).frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(subtitle).font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        sources = (try? await api.memberSources(memberId)) ?? []
    }

    private func connectHealthX() async {
        busy = true; defer { busy = false }
        do {
            let r = try await api.connectMemberSource(memberId, type: .aggregator)
            if let urlStr = r.redirectUrl, let url = URL(string: urlStr) { openURL(url) }
            message = "Verify your identity to import \(memberName)'s records."
            await load()
        } catch { message = "Couldn't start the connection." }
    }

    private func connectEmail() async {
        busy = true; defer { busy = false }
        do {
            let r = try await api.connectMemberEmail(memberId)
            if r.mode == "live", let urlStr = r.redirectUrl, let url = URL(string: urlStr) {
                let ok = await webAuth.start(url: url, callbackScheme: "klove")
                message = ok
                    ? "Connected — Klove is scanning \(memberName)'s health email. New records will appear on the timeline."
                    : "Email sign-in was cancelled."
            } else {
                message = "Scanned email — found \(r.scanned ?? 0) message(s). New records are landing on the timeline."
            }
            await load()
        } catch { message = "Couldn't scan email." }
    }

    private func disconnect(_ type: SourceType) async {
        busy = true; defer { busy = false }
        try? await api.disconnectMemberSource(memberId, type: type)
        await load()
    }

    private func upload(_ data: Data) async {
        busy = true; defer { busy = false }
        do {
            _ = try await api.uploadForMember(memberId, data: data, mimeType: "image/jpeg", filename: "scan.jpg")
            message = "Uploaded — Klove is reading it and will add it to the timeline."
            await load()
        } catch { message = "Upload failed." }
    }
}
