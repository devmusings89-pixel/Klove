import SwiftUI

/// The Records tab — pivots by family member. Pick a member to see their clean chronological
/// timeline; jump to their connections to add more sources.
struct RecordsView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var selectedId: String?
    @State private var entries: [TimelineEntry] = []
    @State private var loading = true
    private let api = APIClient()

    private var members: [HouseholdMember] { store.actionableMembers }
    private var selected: HouseholdMember? {
        if let id = selectedId, let m = members.first(where: { $0.userId == id }) { return m }
        if let me = members.first(where: { $0.memberType == "self" }) { return me }
        return members.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if members.count > 1 { memberPicker }

                NavigationLink {
                    if let m = selected { MemberConnectView(memberId: m.userId, memberName: m.name) }
                } label: {
                    Label("Connections & sources", systemImage: "link")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                        .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
                }

                if loading && entries.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if entries.isEmpty {
                    emptyState
                } else {
                    Text("Timeline").font(.headline).foregroundStyle(Theme.ink)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(entries) { TimelineRow(entry: $0) }
                    }
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Records")
        .task { await initialLoad() }
        .refreshable { await loadTimeline() }
        .onChange(of: selectedId) { Task { await loadTimeline() } }
        .onChange(of: store.dataVersion) { Task { await loadTimeline() } }
    }

    private var memberPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(members) { m in
                    let active = m.userId == selected?.userId
                    Button { selectedId = m.userId } label: {
                        Text(m.name)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(active ? .white : Theme.ink)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(active ? Theme.accent : Theme.surface, in: Capsule())
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "list.bullet.clipboard").font(.largeTitle).foregroundStyle(Theme.accent)
            Text("No records yet").font(.headline).foregroundStyle(Theme.ink)
            Text("Connect a source or upload a document for \(selected?.name ?? "this member") and their timeline builds here.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.top, 40).padding(.horizontal, 16)
    }

    private func initialLoad() async {
        if store.members.isEmpty { await store.load() }
        if selectedId == nil { selectedId = selected?.userId }
        await loadTimeline()
    }

    private func loadTimeline() async {
        guard let id = selected?.userId else { loading = false; return }
        loading = true
        defer { loading = false }
        entries = (try? await api.memberTimeline(id)) ?? []
    }
}
