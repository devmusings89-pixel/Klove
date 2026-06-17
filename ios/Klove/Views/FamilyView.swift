import SwiftUI

/// The heart of the product: each member's status and care context. Add members, see who needs
/// attention, and drill into a member's profile (records, consent, actions).
struct FamilyView: View {
    @Environment(HouseholdStore.self) private var store
    @State private var showAdd = false
    @State private var justAddedAdult: AddMemberResponse?
    @State private var pendingInvite: AddMemberResponse?

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if store.members.isEmpty && store.loadFailed {
                    ConnectionErrorView { Task { await store.load() } }
                } else if store.members.isEmpty && store.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 50)
                } else {
                    ForEach(store.members) { member in
                        NavigationLink(value: member) {
                            MemberCard(member: member)
                        }
                        .buttonStyle(.plain)
                    }

                    Button { showAdd = true } label: {
                        Label("Add a family member", systemImage: "plus.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
                    }
                    .padding(.top, 4)
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .contentMargins(.bottom, 80, for: .scrollContent)
        .navigationTitle("Family")
        .navigationDestination(for: HouseholdMember.self) { member in
            MemberProfileView(memberId: member.userId)
        }
        .sheet(isPresented: $showAdd, onDismiss: {
            // Present the invite only after the Add sheet has fully dismissed (avoids sheet-on-sheet).
            if let adult = justAddedAdult { justAddedAdult = nil; pendingInvite = adult }
        }) {
            AddMemberView(onInvite: { justAddedAdult = $0 }).environment(store)
        }
        .sheet(item: $pendingInvite) { adult in
            InviteMemberView(memberId: adult.userId, memberName: adult.displayName ?? "this member").environment(store)
        }
        .refreshable { await store.load() }
        .task { if store.members.isEmpty { await store.load() } }
    }
}

private struct MemberCard: View {
    let member: HouseholdMember

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: member.symbol)
                .font(.title2)
                .foregroundStyle(Theme.accent)
                .frame(width: 44, height: 44)
                .background(Theme.accentSoft, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(member.name).font(.headline).foregroundStyle(Theme.ink)
                Text(relationshipLabel).font(.caption).foregroundStyle(Theme.inkSecondary)
            }

            Spacer()

            if member.needsYou > 0 {
                Text("\(member.needsYou)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(Theme.needsYou, in: Circle())
            } else {
                consentBadge
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        .kloveCard()
    }

    private var relationshipLabel: String {
        if member.isOperator { return "You · Operator" }
        switch member.memberType {
        case "minor": return "Child · you manage"
        case "aging_parent": return "Parent · delegated"
        case "consenting_adult": return member.consent == "pending" ? "Invite pending" : "Adult · shared with you"
        default: return member.relationship.capitalized
        }
    }

    @ViewBuilder private var consentBadge: some View {
        switch member.consent {
        case "pending":
            Text("Pending").font(.caption2.weight(.semibold)).foregroundStyle(Theme.waiting)
        case "revoked":
            Text("Revoked").font(.caption2.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
        default:
            EmptyView()
        }
    }
}
