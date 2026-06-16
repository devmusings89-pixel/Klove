import SwiftUI

/// The notifications inbox: calm, conversational nudges & confirmations — not a pile of unread.
struct NotificationsInboxView: View {
    var onRead: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var items: [KloveNotification] = []
    @State private var loading = true
    private let api = APIClient()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    if loading && items.isEmpty {
                        ProgressView().padding(.top, 60)
                    } else if items.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "bell.slash").font(.largeTitle).foregroundStyle(Theme.inkSecondary)
                            Text("You're all caught up").font(.headline).foregroundStyle(Theme.ink)
                        }.padding(.top, 80)
                    } else {
                        ForEach(items) { n in
                            Button { Task { await read(n) } } label: { row(n) }.buttonStyle(.plain)
                        }
                    }
                }
                .padding(20)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    private func row(_ n: KloveNotification) -> some View {
        HStack(spacing: 12) {
            Circle().fill(n.readAt == nil ? Theme.accent : Color.clear).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                if let t = n.title { Text(t).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink) }
                Text(n.body).font(.subheadline).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
        }
        .kloveCard()
    }

    private func load() async {
        loading = true
        defer { loading = false }
        items = (try? await api.getNotifications().messages) ?? []
    }

    private func read(_ n: KloveNotification) async {
        guard n.readAt == nil else { return }
        try? await api.markNotificationRead(n.id)
        await load()
        onRead()
    }
}
