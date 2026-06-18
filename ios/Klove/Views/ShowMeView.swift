import SwiftUI
import Charts

/// On-demand "Show me" view for one member — a focused, grounded answer pulled from the record.
/// Data on pull, never a dashboard: ask, see, act, let it go.
struct ShowMeView: View {
    let memberId: String
    let memberName: String

    @State private var query = ""
    @State private var result: ShowMeResult?
    @State private var loading = false
    @State private var adding = false
    @State private var added = false
    private let api = APIClient()

    private var firstName: String { String(memberName.split(separator: " ").first ?? "their") }
    private var prompts: [String] {
        ["Blood pressure", "Recent labs", "Medications", "Upcoming visits"]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                HStack {
                    TextField("Show me…", text: $query)
                        .textFieldStyle(.plain).font(.kloveBody).padding(12)
                        .background(Theme.surface, in: Capsule())
                        .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))
                        .onSubmit { Task { await run() } }
                    Button { Task { await run() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.background)
                            .frame(width: 40, height: 40).background(query.isEmpty ? Theme.inkSecondary : Theme.accent, in: Circle())
                    }.disabled(query.isEmpty || loading)
                }

                FlowChips(prompts: prompts) { query = $0; Task { await run() } }

                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
                } else if let r = result {
                    if let summary = r.summary, !summary.isEmpty {
                        Text(summary).font(.kloveBody).foregroundStyle(Theme.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    if let s = r.series { trendChart(s) }
                    if r.entries.isEmpty && r.series == nil {
                        Text("Nothing on file for \"\(r.title)\" yet.").font(.kloveBody).foregroundStyle(Theme.inkSecondary).kloveCard()
                    } else if !r.entries.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            SectionLabel(title: "\(r.count) result\(r.count == 1 ? "" : "s") for \(r.title)")
                            ForEach(r.entries) { e in
                                HStack(spacing: Theme.Spacing.md) {
                                    AvatarChip(initials: kloveInitials(memberName), symbol: e.symbol, size: 40)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(e.title).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                                        if let d = e.detail { Text(d).font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                                    }
                                    Spacer()
                                    Text(e.displayDate).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                                }
                                .kloveCard()
                            }
                        }
                    }

                    if hasContent(r) {
                        Button { Task { await addToBrief(r) } } label: {
                            Label(added ? "Added to \(firstName)'s brief" : "Add to \(firstName)'s brief",
                                  systemImage: added ? "checkmark" : "plus")
                        }
                        .buttonStyle(KlovePrimaryButtonStyle())
                        .disabled(adding || added)
                        .padding(.top, Theme.Spacing.xs)
                    }
                }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Show me · \(memberName)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func hasContent(_ r: ShowMeResult) -> Bool {
        (r.summary?.isEmpty == false) || !r.entries.isEmpty || r.series != nil
    }

    private func run() async {
        guard !query.isEmpty else { return }
        loading = true
        added = false
        defer { loading = false }
        result = try? await api.showMe(memberId, query: query)
    }

    private func addToBrief(_ r: ShowMeResult) async {
        adding = true
        defer { adding = false }
        let detail = r.summary ?? r.entries.first?.detail
        if (try? await api.addToBrief(memberId, title: r.title, detail: detail)) != nil { added = true }
    }

    private func trendChart(_ s: ShowMeSeries) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(s.display + (s.unit.map { " (\($0))" } ?? "")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            Chart(s.points) { p in
                LineMark(x: .value("Date", p.parsedDate), y: .value("Value", p.value))
                    .foregroundStyle(Theme.accent)
                PointMark(x: .value("Date", p.parsedDate), y: .value("Value", p.value))
                    .foregroundStyle(Theme.accent)
            }
            .frame(height: 180)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }
}

/// Simple wrapping chip row of quick prompts.
private struct FlowChips: View {
    let prompts: [String]
    var onTap: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(prompts, id: \.self) { p in
                    Button { onTap(p) } label: {
                        Text(p).font(.caption.weight(.medium)).foregroundStyle(Theme.accent)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Theme.accentSoft, in: Capsule())
                    }
                }
            }
        }
    }
}
