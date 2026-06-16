import AuthenticationServices
import UIKit

/// Drives an ASWebAuthenticationSession for OAuth source connections (e.g. Gmail consent).
/// Returns true if the user completed the flow (a callback URL was delivered).
@MainActor
final class WebAuthCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, callbackScheme: String) async -> Bool {
        await authenticate(url: url, callbackScheme: callbackScheme) != nil
    }

    /// Like `start`, but returns the full callback URL (needed to read OAuth tokens from the fragment).
    func authenticate(url: URL, callbackScheme: String) async -> URL? {
        await withCheckedContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, _ in
                continuation.resume(returning: callbackURL)
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
