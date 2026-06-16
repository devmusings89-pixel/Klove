import SwiftUI

/// Catches `klove://invite/<token>` deep links and surfaces them so the invitee can accept and
/// choose what to share. (Supabase OAuth and Gmail callbacks are handled by ASWebAuthenticationSession,
/// not onOpenURL, so the only link that reaches here is an invite.)
@MainActor
@Observable
final class InviteCoordinator {
    static let shared = InviteCoordinator()
    var pending: PendingInvite?

    func handle(_ url: URL) {
        guard url.scheme == "klove", url.host == "invite" else { return }
        let token = url.lastPathComponent
        if !token.isEmpty, token != "invite" { pending = PendingInvite(token: token) }
    }
}

struct PendingInvite: Identifiable {
    let token: String
    var id: String { token }
}
