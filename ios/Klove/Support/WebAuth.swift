import AuthenticationServices
import UIKit

/// Drives an ASWebAuthenticationSession for OAuth source connections (e.g. Gmail consent).
/// Returns true if the user completed the flow (a callback URL was delivered).
@MainActor
final class WebAuthCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, callbackScheme: String) async -> Bool {
        await withCheckedContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
                continuation.resume(returning: callbackURL != nil && error == nil)
            }
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes
            .first { $0.activationState == .foregroundActive } as? UIWindowScene
        return scene?.keyWindow ?? ASPresentationAnchor()
    }
}
