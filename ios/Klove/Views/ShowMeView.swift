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
    private let api = APIClient()

    private var prompts: [String] {
        ["Blood pressure", "Recent labs", "Medications", "Upcoming visits"]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    TextField("Show me…", text: $query)
                        .textFieldStyle(.plain).padding(12)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                        .onSubmit { Task { await run() } }
                    Button { Task { await run() } } label: {
                        Image(systemName: "magnifyingglass.circle.fill").font(.title).foregroundStyle(Theme.accent)
                    }.disabled(query.isEmpty || loading)
                }

                FlowChips(prompts: prompts) { query = $0; Task { await run() } }

                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
                } else if let r = result {
                    if let s = r.series { trendChart(s) }
                    if r.entries.isEmpty && r.series == nil {
                        Text("Nothing on file for \"\(r.title)\" yet.").font(.subheadline).foregroundStyle(Theme.inkSecondary).kloveCard()
                    } else if !r.entries.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("\(r.count) result\(r.count == 1 ? "" : "s") for \"\(r.title)\"")
                                .font(.caption).foregroundStyle(Theme.inkSecondary)
                            ForEach(r.entries) { e in
                                HStack(spacing: 10) {
                                    Image(systemName: e.symbol).foregroundStyle(Theme.accent).frame(width: 24)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(e.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                                        if let d = e.detail { Text(d).font(.caption).foregroundStyle(Theme.inkSecondary) }
                                    }
                                    Spacer()
                                    Text(e.displayDate).font(.caption2).foregroundStyle(Theme.inkSecondary)
                                }
                                .kloveCard()
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Show me · \(memberName)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run() async {
        guard !query.isEmpty else { return }
        loading = true
        defer { loading = false }
        result = try? await api.showMe(memberId, query: query)
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
