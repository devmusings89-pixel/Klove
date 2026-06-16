import SwiftUI

/// One member's context and the operator's consent over them. Phase 1 shows identity + consent and
/// the manage/revoke/invite controls; per-member records & timeline arrive in Phase 2.
struct MemberProfileView: View {
    let memberId: String
    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var detail: MemberDetail?
    @State private var loading = true
    @State private var showInvite = false
    @State private var showBook = false
    @State private var confirmRevoke = false

    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let d = detail {
                    identity(d)
                    if d.consent.status == "self" || d.consent.status == "active" { careLinks(d) }
                    consentCard(d)
                    if !d.isOperator { manageSection(d) }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else {
                    Text("Couldn't load this member.").foregroundStyle(Theme.inkSecondary)
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(detail?.displayName ?? "Member")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showInvite) {
            InviteMemberView(memberId: memberId, memberName: detail?.displayName ?? "this member").environment(store)
        }
        .sheet(isPresented: $showBook) {
            BookAppointmentView(memberId: memberId, memberName: detail?.displayName ?? "this member")
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        detail = try? await api.getMember(memberId)
    }

    private func identity(_ d: MemberDetail) -> some View {
        HStack(spacing: 16) {
            Image(systemName: symbol(d))
                .font(.largeTitle)
                .foregroundStyle(Theme.accent)
                .frame(width: 64, height: 64)
                .background(Theme.accentSoft, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(d.displayName ?? "Member").font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(typeLabel(d)).font(.subheadline).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
        }
    }

    private func careLinks(_ d: MemberDetail) -> some View {
        VStack(spacing: 0) {
            NavigationLink {
                MemberTimelineView(memberId: memberId, memberName: d.displayName ?? "this member")
            } label: {
                careRow(icon: "clock.arrow.circlepath", title: "Health timeline", subtitle: "Clean chronological record")
            }
            Divider().padding(.leading, 52)
            NavigationLink {
                ShowMeView(memberId: memberId, memberName: d.displayName ?? "this member")
            } label: {
                careRow(icon: "sparkle.magnifyingglass", title: "Show me", subtitle: "Ask for a focused view")
            }
            Divider().padding(.leading, 52)
            NavigationLink {
                AppointmentBriefView(memberId: memberId, memberName: d.displayName ?? "this member")
            } label: {
                careRow(icon: "list.clipboard.fill", title: "Prepare for a visit", subtitle: "One-page brief + questions")
            }
            Divider().padding(.leading, 52)
            Button { showBook = true } label: {
                careRow(icon: "calendar.badge.plus", title: "Book a visit", subtitle: "Klove schedules it for you")
            }
            .buttonStyle(.plain)
            Divider().padding(.leading, 52)
            NavigationLink {
                MemberConnectView(memberId: memberId, memberName: d.displayName ?? "this member")
            } label: {
                careRow(icon: "link", title: "Connections", subtitle: "Sources & documents")
            }
        }
        .kloveCard()
    }

    private func careRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).foregroundStyle(Theme.accent).frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(subtitle).font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func consentCard(_ d: MemberDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Consent", systemImage: "hand.raised.fill").font(.headline).foregroundStyle(Theme.ink)
            row("Status", value: d.consent.status.capitalized)
            if let level = d.consent.accessLevel { row("Access", value: level.capitalized) }
            row("Sharing", value: d.consent.categories.map(prettyCategory).joined(separator: ", "))
            Text("Consent is always visible and revocable — you can disconnect at any time.")
                .font(.caption).foregroundStyle(Theme.inkSecondary).padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    @ViewBuilder private func manageSection(_ d: MemberDetail) -> some View {
        VStack(spacing: 12) {
            if d.consent.status == "pending" {
                Button { showInvite = true } label: {
                    Label("Send invite", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                .foregroundStyle(.white).background(Theme.accent, in: RoundedRectangle(cornerRadius: 12))
            }
            if d.consent.status == "active" {
                Button(role: .destructive) { confirmRevoke = true } label: {
                    Label("Revoke access", systemImage: "xmark.shield.fill")
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                .tint(.red)
                .confirmationDialog("Revoke Klove's access to \(d.displayName ?? "this member")?", isPresented: $confirmRevoke, titleVisibility: .visible) {
                    Button("Revoke access", role: .destructive) {
                        Task { await store.revoke(memberId: memberId); await load() }
                    }
                }
            }
        }
    }

    private func row(_ label: String, value: String) -> some View {
        HStack {
            Text(label).font(.subheadline).foregroundStyle(Theme.inkSecondary)
            Spacer()
            Text(value).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
        }
    }

    private func symbol(_ d: MemberDetail) -> String {
        switch d.memberType {
        case "self": return "person.fill"
        case "minor": return "figure.child"
        case "aging_parent": return "figure.2.arms.open"
        default: return "person.2.fill"
        }
    }

    private func typeLabel(_ d: MemberDetail) -> String {
        if d.isOperator { return "You · Operator" }
        switch d.memberType {
        case "minor": return "Child · you manage their care"
        case "aging_parent": return "Aging parent · delegated"
        case "consenting_adult": return "Adult · shares with you"
        default: return d.relationship.capitalized
        }
    }

    private func prettyCategory(_ c: String) -> String {
        switch c {
        case "all": return "Everything"
        case "records": return "Records"
        case "apple_health": return "Apple Health"
        case "appointments": return "Appointments"
        default: return c.capitalized
        }
    }
}
