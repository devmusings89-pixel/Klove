import SwiftUI

/// The Records tab — pivots by family member. Pick a member to see their clean health story, as a
/// chronological timeline or grouped by record type; tap any entry to open its detail. Jump to their
/// connections to add more sources.
struct RecordsView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var selectedId: String?
    @State private var entries: [TimelineEntry] = []
    @State private var loading = true
    @State private var segment = 0   // 0 = Timeline, 1 = Records
    private let api = APIClient()

    private var members: [HouseholdMember] { store.actionableMembers }
    private var selected: HouseholdMember? {
        if let id = selectedId, let m = members.first(where: { $0.userId == id }) { return m }
        if let me = members.first(where: { $0.memberType == "self" }) { return me }
        return members.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if members.count > 1 { memberPicker }
                KloveSegmentedControl(segments: ["Timeline", "Records"], selection: $segment)
                sourcesLink

                if loading && entries.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if entries.isEmpty {
                    emptyState
                } else if segment == 0 {
                    timeline
                } else {
                    grouped
                }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .contentMargins(.bottom, 80, for: .scrollContent)
        .navigationTitle("Records")
        .navigationDestination(for: RecordDetail.self) { HealthRecordDetailView(detail: $0) }
        .task { await initialLoad() }
        .refreshable { await loadTimeline() }
        .onChange(of: selectedId) { Task { await loadTimeline() } }
        .onChange(of: store.dataVersion) { Task { await loadTimeline() } }
    }

    // MARK: Timeline (chronological, grouped by month)

    private var timeline: some View {
        ForEach(monthGroups, id: \.key) { group in
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionLabel(title: group.key)
                ForEach(group.entries) { recordLink($0) }
            }
            .padding(.top, Theme.Spacing.sm)
        }
    }

    // MARK: Grouped by record type

    private var grouped: some View {
        ForEach(kindGroups, id: \.key) { group in
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionLabel(title: group.key, count: group.entries.count)
                ForEach(group.entries) { recordLink($0) }
            }
            .padding(.top, Theme.Spacing.sm)
        }
    }

    private func recordLink(_ entry: TimelineEntry) -> some View {
        NavigationLink(value: entry.recordDetail) {
            HStack(spacing: Theme.Spacing.md) {
                AvatarChip(initials: kloveInitials(selected?.name ?? ""), symbol: entry.symbol, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(entry.displayDate).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                }
                Spacer(minLength: Theme.Spacing.sm)
                if entry.abnormal == true { StatusChip(text: "Flag", emphasized: true) }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            .kloveCard()
        }
        .buttonStyle(.plain)
    }

    // MARK: Grouping helpers

    private var monthGroups: [(key: String, entries: [TimelineEntry])] {
        let fmtIn = ISO8601DateFormatter()
        let fmtOut = DateFormatter(); fmtOut.dateFormat = "MMMM yyyy"
        var order: [String] = []
        var map: [String: [TimelineEntry]] = [:]
        for e in entries {
            let key = (e.date.flatMap { fmtIn.date(from: $0) }).map { fmtOut.string(from: $0).uppercased() } ?? "EARLIER"
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(e)
        }
        return order.map { ($0, map[$0]!) }
    }

    private var kindGroups: [(key: String, entries: [TimelineEntry])] {
        let labels = ["observation": "Labs & vitals", "condition": "Conditions", "medication": "Medications",
                      "report": "Reports", "allergy": "Allergies", "appointment": "Appointments"]
        var order: [String] = []
        var map: [String: [TimelineEntry]] = [:]
        for e in entries {
            let key = labels[e.kind] ?? e.kind.capitalized
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(e)
        }
        return order.map { ($0, map[$0]!) }
    }

    // MARK: Member picker + sources link

    private var memberPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(members) { m in
                    let active = m.userId == selected?.userId
                    Button { selectedId = m.userId } label: {
                        HStack(spacing: 6) {
                            Text(kloveInitials(m.name))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(active ? Theme.accent : Theme.ink)
                                .frame(width: 22, height: 22)
                                .background(active ? Theme.background : Theme.surfaceSunken, in: Circle())
                            Text(m.memberType == "self" ? "You" : String(m.name.split(separator: " ").first ?? ""))
                                .font(.kloveBodyStrong)
                        }
                        .foregroundStyle(active ? Theme.background : Theme.ink)
                        .padding(.leading, 6).padding(.trailing, 16).padding(.vertical, 6)
                        .frame(minHeight: 34)
                        .background(active ? Theme.accent : Theme.surface, in: Capsule())
                        .overlay(Capsule().stroke(Theme.hairline, lineWidth: active ? 0 : 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private var sourcesLink: some View {
        NavigationLink {
            if let m = selected { MemberConnectView(memberId: m.userId, memberName: m.name) }
        } label: {
            HStack {
                Label("Connected sources", systemImage: "link")
                    .font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            .padding(14)
            .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.text").font(.largeTitle).foregroundStyle(Theme.ink)
            Text("No records yet").font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Text("Connect a source or upload a document for \(selected?.name ?? "this member") and their timeline builds here.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
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
