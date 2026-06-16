import AuthenticationServices
import CryptoKit
import Foundation

/// Sign in with Apple → (optionally) a Supabase session JWT. The token is sent as a Bearer header by
/// APIClient; when Supabase isn't configured we fall back to a stable Apple-derived identity via the
/// dev `x-user-email` header. Either way the user has a real, per-Apple-ID identity and a sign-out.
@MainActor
@Observable
final class AuthService: NSObject {
    static let shared = AuthService()

    var errorMessage: String?
    private var currentNonce: String?

    var isSignedIn: Bool {
        UserDefaults.standard.string(forKey: AppStorageKey.authToken) != nil
            || !(UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "").isEmpty
    }

    var email: String { UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "" }

    /// Configure the Apple request with the requested scopes + a hashed nonce (Supabase verifies it).
    func configure(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = Self.randomNonce()
        currentNonce = nonce
        request.requestedScopes = [.email, .fullName]
        request.nonce = Self.sha256(nonce)
    }

    /// Handle the Sign in with Apple result: persist identity, exchange for a Supabase JWT if configured.
    func handle(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure(let err):
            // User cancelling isn't an error worth surfacing.
            if (err as? ASAuthorizationError)?.code != .canceled { errorMessage = err.localizedDescription }
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential else { return }
            // Apple returns the email only on first consent — cache it keyed by the stable user id.
            let cacheKey = "appleEmail-\(cred.user)"
            if let e = cred.email { UserDefaults.standard.set(e, forKey: cacheKey) }
            let email = UserDefaults.standard.string(forKey: cacheKey) ?? "\(cred.user.prefix(12))@appleid.klove"
            UserDefaults.standard.set(email, forKey: AppStorageKey.userEmail)
            UserDefaults.standard.set(true, forKey: AppStorageKey.hasOnboarded)
            errorMessage = nil

            if let data = cred.identityToken, let idToken = String(data: data, encoding: .utf8),
               !Config.supabaseURL.isEmpty, !Config.supabaseAnonKey.isEmpty {
                Task { await exchangeWithSupabase(idToken: idToken) }
            }
        }
    }

    /// Sign in with Google via Supabase's OAuth web flow (ASWebAuthenticationSession). Tokens come
    /// back in the callback URL fragment. Requires Supabase configured (Google provider enabled).
    private var webAuth: WebAuthCoordinator?
    func signInWithGoogle() async {
        guard !Config.supabaseURL.isEmpty else {
            errorMessage = "Google sign-in needs Supabase configured (set Config.supabaseURL)."
            return
        }
        let redirect = "klove://auth-callback"
        guard let encoded = redirect.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(Config.supabaseURL)/auth/v1/authorize?provider=google&redirect_to=\(encoded)") else { return }

        let coordinator = WebAuthCoordinator()
        webAuth = coordinator
        guard let callback = await coordinator.authenticate(url: url, callbackScheme: "klove"),
              let token = Self.fragmentParam(callback, "access_token") else {
            errorMessage = nil // user cancelled or no token
            return
        }
        UserDefaults.standard.set(token, forKey: AppStorageKey.authToken)
        UserDefaults.standard.set(Self.emailFromJWT(token) ?? "you@gmail.com", forKey: AppStorageKey.userEmail)
        UserDefaults.standard.set(true, forKey: AppStorageKey.hasOnboarded)
        errorMessage = nil
    }

    func signOut() {
        UserDefaults.standard.removeObject(forKey: AppStorageKey.authToken)
        UserDefaults.standard.removeObject(forKey: AppStorageKey.userEmail)
        UserDefaults.standard.set(false, forKey: AppStorageKey.hasOnboarded)
    }

    /// Exchange the Apple identity token for a Supabase session (live JWT path). Best-effort.
    private func exchangeWithSupabase(idToken: String) async {
        guard let url = URL(string: "\(Config.supabaseURL)/auth/v1/token?grant_type=id_token") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "provider": "apple", "id_token": idToken, "nonce": currentNonce ?? "",
        ])
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["access_token"] as? String else { return }
        UserDefaults.standard.set(token, forKey: AppStorageKey.authToken)
    }

    // MARK: - Nonce helpers (standard Sign in with Apple + Supabase flow)

    private static func randomNonce(_ length: Int = 32) -> String {
        let chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._"
        var result = ""
        var remaining = length
        while remaining > 0 {
            var random: UInt8 = 0
            _ = SecRandomCopyBytes(kSecRandomDefault, 1, &random)
            if random < UInt8(chars.count) {
                result.append(chars[chars.index(chars.startIndex, offsetBy: Int(random))])
                remaining -= 1
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Read a param from an OAuth callback URL fragment (`klove://auth-callback#access_token=…&…`).
    private static func fragmentParam(_ url: URL, _ key: String) -> String? {
        let frag = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment ?? url.fragment ?? ""
        for pair in frag.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2, kv[0] == key { return String(kv[1]).removingPercentEncoding ?? String(kv[1]) }
        }
        return nil
    }

    /// Best-effort decode of the `email` claim from a JWT (for display only; not verification).
    private static func emailFromJWT(_ jwt: String) -> String? {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["email"] as? String
    }
}
