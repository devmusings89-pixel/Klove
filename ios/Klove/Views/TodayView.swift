import SwiftUI

/// The chief-of-staff briefing. What needs you, what's handled, what Klove is waiting on — one
/// clear next step at a time, filterable by household member. Backed by GET /today.
struct TodayView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var briefing: TodayBriefing?
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showSettings = false
    @State private var showNotifications = false
    @State private var unread = 0
    /// nil == "All members"; otherwise a member userId. Local to Today so it doesn't disturb the
    /// global member-scoped screens (Records) that read `store.selectedMember`.
    @State private var memberFilter: String?

    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                header
                MemberFilterBar(members: store.members, selection: $memberFilter)

                if loading && briefing == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if let b = briefing {
                    let needsYou = filter(b.needsYou)
                    let waiting = filter(b.waiting)
                    let handled = filter(b.handled)
                    let appts = filterAppts(b.upcomingAppointments)

                    if needsYou.isEmpty && appts.isEmpty { allHandledCard }
                    else { section("Needs your attention", tasks: needsYou, extraCount: appts.count) {
                        ForEach(appts) { appointmentRow($0) }
                        ForEach(needsYou) { taskRow($0, action: actionWord($0)) }
                    } }

                    if !waiting.isEmpty {
                        section("Waiting on others", tasks: waiting) {
                            ForEach(waiting) { taskRow($0, action: nil) }
                        }
                    }
                    if !handled.isEmpty {
                        section("Handled by Klove", tasks: handled) {
                            ForEach(handled) { taskRow($0, action: nil) }
                        }
                    }
                } else if loadFailed {
                    ConnectionErrorView { Task { await load() } }
                }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .contentMargins(.bottom, 80, for: .scrollContent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .navigationDestination(for: KloveTask.self) { TaskDetailView(task: $0, onChange: { Task { await load() } }) }
        .sheet(isPresented: $showSettings) { NavigationStack { SettingsView() } }
        .sheet(isPresented: $showNotifications) { NotificationsInboxView(onRead: { Task { await loadUnread() } }) }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: store.dataVersion) { Task { await load() } }
    }

    // MARK: Filtering

    private func filter(_ tasks: [KloveTask]) -> [KloveTask] {
        guard let id = memberFilter else { return tasks }
        return tasks.filter { $0.subjectUserId == id }
    }
    private func filterAppts(_ appts: [UpcomingAppt]) -> [UpcomingAppt] {
        guard let id = memberFilter else { return appts }
        return appts.filter { $0.subjectUserId == id }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased())
                .font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
                .padding(.bottom, 6)
            Text("\(greeting), \(operatorFirstName).")
                .font(.kloveTitle).foregroundStyle(Theme.ink)
            Text("Here's your brief.")
                .font(.kloveTitleItalic).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { showNotifications = true } label: {
                Image(systemName: unread > 0 ? "bell.badge" : "bell").foregroundStyle(Theme.ink)
            }.accessibilityLabel("Notifications")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { showSettings = true } label: {
                Text(kloveInitials(operatorFirstName))
                    .font(.system(size: 14, design: .serif)).foregroundStyle(Theme.ink)
                    .frame(width: 34, height: 34)
                    .background(Theme.surface, in: Circle())
                    .overlay(Circle().stroke(Theme.hairline, lineWidth: 1))
            }.accessibilityLabel("Account")
        }
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 0..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }
    private var operatorFirstName: String {
        let name = store.members.first { $0.memberType == "self" }?.name
            ?? store.household?.name ?? "there"
        return String(name.split(separator: " ").first ?? "there")
    }

    // MARK: Rows

    @ViewBuilder
    private func section(_ title: String, tasks: [KloveTask], extraCount: Int = 0,
                         @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(title: title, count: tasks.count + extraCount)
            content()
        }
    }

    private func taskRow(_ task: KloveTask, action: String?) -> some View {
        NavigationLink(value: task) {
            BriefRow(
                initials: kloveInitials(task.memberName ?? operatorFirstName),
                symbol: task.kindSymbol,
                title: task.displayTitle,
                subtitle: subtitle(task),
                trailing: action
            )
        }
        .buttonStyle(.plain)
    }

    private func appointmentRow(_ a: UpcomingAppt) -> some View {
        NavigationLink {
            AppointmentDetailView(memberId: a.subjectUserId ?? "", memberName: a.memberName ?? "this member",
                                  appt: a, onChange: { Task { await load() } })
        } label: {
            BriefRow(
                initials: kloveInitials(a.memberName ?? operatorFirstName),
                symbol: "calendar",
                title: a.title,
                subtitle: [a.memberName, a.provider].compactMap { $0 }.joined(separator: " · "),
                trailing: a.isProvisional ? "Confirm" : "Prep"
            )
        }
        .buttonStyle(.plain)
    }

    private func subtitle(_ task: KloveTask) -> String {
        if let d = task.detail, !d.isEmpty { return d }
        if let f = task.followUp { return f.actionLabel }
        if let b = task.booking { return b.whenDisplay }
        return task.memberName ?? ""
    }

    /// The right-aligned next-step word for a needs-you item ("Prep", "Review", "Book").
    private func actionWord(_ task: KloveTask) -> String {
        switch task.kind {
        case "prep": return "Prep"
        case "book": return "Book"
        case "follow_up": return "Follow up"
        case "choose_time": return "Choose"
        default: return "Review"
        }
    }

    private var allHandledCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("All handled").font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Text("Nothing needs you right now. Klove is watching your family's care and will surface the one next step when something comes up.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    // MARK: Loading

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            briefing = try await api.getToday()   // only overwrite good data on success
            loadFailed = false
        } catch {
            loadFailed = true
        }
        await loadUnread()
    }
    private func loadUnread() async {
        unread = (try? await api.getNotifications().unread) ?? 0
    }
}

/// The canonical compact Today/brief row: member avatar · title + one-line subtitle · trailing action
/// word (or chevron). One look across "needs attention", "waiting", and "handled".
struct BriefRow: View {
    var initials: String
    var symbol: String
    var title: String
    var subtitle: String
    /// nil → show a chevron (drill-in); non-nil → show the action word.
    var trailing: String?

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            AvatarChip(initials: initials, symbol: symbol, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Theme.Spacing.sm)
            if let trailing {
                Text(trailing).font(.system(.subheadline, design: .serif)).foregroundStyle(Theme.ink)
            } else {
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
            }
        }
        .kloveCard()
    }
}
