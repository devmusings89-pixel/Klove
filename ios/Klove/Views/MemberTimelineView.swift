import SwiftUI

/// A member's clean, chronological health story — the trusted, normalized record (not raw files).
struct MemberTimelineView: View {
    let memberId: String
    let memberName: String

    @State private var entries: [TimelineEntry] = []
    @State private var loading = true
    private let api = APIClient()

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if entries.isEmpty {
                    emptyState
                } else {
                    ForEach(entries) { entry in
                        TimelineRow(entry: entry)
                    }
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("\(memberName)'s timeline")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        entries = (try? await api.memberTimeline(memberId)) ?? []
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath").font(.largeTitle).foregroundStyle(Theme.accent)
            Text("Nothing here yet").font(.headline).foregroundStyle(Theme.ink)
            Text("Connect a source or upload a document, and \(memberName)'s health story will build here automatically.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.top, 60).padding(.horizontal, 24)
    }
}

private struct TimelineRow: View {
    let entry: TimelineEntry

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Image(systemName: entry.symbol)
                    .font(.caption)
                    .foregroundStyle(entry.abnormal == true ? Theme.needsYou : Theme.accent)
                    .frame(width: 30, height: 30)
                    .background((entry.abnormal == true ? Theme.needsYou : Theme.accent).opacity(0.12), in: Circle())
                Rectangle().fill(Theme.ink.opacity(0.08)).frame(width: 1.5)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.displayDate).font(.caption2).foregroundStyle(Theme.inkSecondary)
                Text(entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                if let detail = entry.detail {
                    Text(detail).font(.caption).foregroundStyle(Theme.inkSecondary)
                }
                Text(entry.source.capitalized).font(.caption2).foregroundStyle(Theme.inkSecondary.opacity(0.7))
            }
            .padding(.bottom, 16)
            Spacer()
        }
    }
}
