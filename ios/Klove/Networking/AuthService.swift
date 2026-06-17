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
    /// Observable session flag. Auth success flips this to true WITHOUT completing onboarding, so the
    /// onboarding flow can keep collecting details (name/DOB/family/records) before `hasOnboarded`.
    var isAuthenticated = false
    private var currentNonce: String?

    override init() {
        super.init()
        isAuthenticated = isSignedIn
    }
    /// One-time CSRF nonce for the Google OAuth web flow; verified against the callback's `state`.
    private var oauthState: String?

    /// True when the app is configured to obtain real JWTs (Supabase live). In that case a leftover
    /// `userEmail` alone must NOT count as signed in — only a stored bearer token does. In a pure
    /// mock build (no Supabase) the dev email identity is still accepted.
    private var requiresRealToken: Bool { !Config.supabaseURL.isEmpty && !Config.supabaseAnonKey.isEmpty }

    /// The stored auth JWT (Keychain-backed), or nil.
    private var authToken: String? { KeychainStore.get(AppStorageKey.authToken) }

    var isSignedIn: Bool {
        if authToken != nil { return true }
        // No token: only the mock/dev build may treat a saved email as signed in.
        if requiresRealToken { return false }
        return !(UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? "").isEmpty
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
            errorMessage = nil

            if requiresRealToken {
                // Live build: the user is only signed in once we obtain a Supabase JWT. Defer
                // hasOnboarded until the exchange succeeds; surface failures instead of silently
                // leaving a half-authenticated state.
                guard let data = cred.identityToken, let idToken = String(data: data, encoding: .utf8) else {
                    errorMessage = "Couldn't sign you in. Please try again."
                    return
                }
                Task { await exchangeWithSupabase(idToken: idToken) }
            } else {
                // Mock/dev build: the Apple-derived email identity is enough to authenticate; the
                // onboarding flow then collects the user's details before finishing.
                isAuthenticated = true
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
        // CSRF protection: send a random `state` and require the callback to echo it back. Without
        // this an attacker could feed us an access_token from a session they control.
        let state = Self.randomNonce()
        oauthState = state
        let redirect = "klove://auth-callback"
        guard let encoded = redirect.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let encodedState = state.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(Config.supabaseURL)/auth/v1/authorize?provider=google&redirect_to=\(encoded)&state=\(encodedState)") else { return }

        let coordinator = WebAuthCoordinator()
        webAuth = coordinator
        guard let callback = await coordinator.authenticate(url: url, callbackScheme: "klove") else {
            errorMessage = nil // user cancelled
            return
        }
        // Verify the returned state matches what we sent (it comes back in the fragment).
        let returnedState = Self.fragmentParam(callback, "state")
        guard let expected = oauthState, returnedState == expected else {
            oauthState = nil
            errorMessage = "Sign-in could not be verified. Please try again."
            return
        }
        oauthState = nil
        guard let token = Self.fragmentParam(callback, "access_token") else {
            errorMessage = nil // no token returned
            return
        }
        KeychainStore.set(token, for: AppStorageKey.authToken)
        UserDefaults.standard.set(Self.emailFromJWT(token) ?? "you@gmail.com", forKey: AppStorageKey.userEmail)
        isAuthenticated = true
        errorMessage = nil
    }

    /// Create a Supabase account with email + password.
    ///
    /// TODO(auth-email-confirmation): email confirmation is currently DISABLED in the Supabase
    /// dashboard (Authentication → Providers → Email → "Confirm email" OFF) so signup returns a
    /// session immediately and this flow logs the user straight in. To re-enable confirmation for
    /// production:
    ///   1. Supabase → URL Configuration: set a real Site URL (not localhost:3000) and add
    ///      `klove://auth-callback` to the Redirect URLs allowlist.
    ///   2. Pass `email_redirect_to=klove://auth-callback` in the signup body below, and add a
    ///      deep-link handler (onOpenURL) that finishes the session from the callback (mirroring
    ///      the Google `signInWithGoogle` fragment/state handling).
    ///   3. Configure custom SMTP + Klove-branded templates so links come from klove.app and clear
    ///      corporate link-scanners (which otherwise pre-consume the one-time OTP → otp_expired).
    @discardableResult
    func signUpWithEmail(_ email: String, _ password: String) async -> Bool {
        if await emailAuth(path: "/auth/v1/signup", email: email, password: password, isSignup: true) {
            return true
        }
        // Signup returned no session. Two cases land here when email confirmation is OFF:
        //   1) the address is already registered — Supabase obfuscates that as a 200 with no session
        //      (anti-enumeration), which looks identical to "confirmation required";
        //   2) some GoTrue versions don't return a session on signup even with confirmation off.
        // In both, signing in succeeds. So try it: if confirmation is genuinely still ON, the sign-in
        // returns "Email not confirmed" and friendlyAuthError surfaces the right message.
        if authToken == nil {
            return await emailAuth(path: "/auth/v1/token?grant_type=password", email: email, password: password, isSignup: false)
        }
        return false
    }

    /// Sign in to an existing Supabase account with email + password.
    @discardableResult
    func signInWithEmail(_ email: String, _ password: String) async -> Bool {
        await emailAuth(path: "/auth/v1/token?grant_type=password", email: email, password: password, isSignup: false)
    }

    private func emailAuth(path: String, email: String, password: String, isSignup: Bool) async -> Bool {
        guard !Config.supabaseURL.isEmpty, !Config.supabaseAnonKey.isEmpty else {
            errorMessage = "Email accounts need Supabase configured."
            return false
        }
        guard let url = URL(string: "\(Config.supabaseURL)\(path)") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])

        guard let (data, resp) = try? await URLSession.shared.data(for: req) else {
            errorMessage = "Couldn't reach the sign-in service."
            return false
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 500
        guard status < 300 else {
            // Don't surface raw Supabase/GoTrue error strings (they can leak internals); map to copy.
            let raw = (json?["msg"] ?? json?["error_description"] ?? json?["error"]) as? String
            errorMessage = Self.friendlyAuthError(raw, status: status, isSignup: isSignup)
            return false
        }
        if let token = json?["access_token"] as? String {
            KeychainStore.set(token, for: AppStorageKey.authToken)
            UserDefaults.standard.set(Self.emailFromJWT(token) ?? email, forKey: AppStorageKey.userEmail)
            isAuthenticated = true
            errorMessage = nil
            return true
        }
        // Signup with email-confirmation ON returns a user but no session.
        errorMessage = "Account created — confirm via the email we sent, then sign in."
        return false
    }

    func signOut() {
        // Best-effort: revoke the Supabase session server-side so the JWT can't be reused.
        if let token = authToken, !Config.supabaseURL.isEmpty {
            Task { await revokeSupabaseSession(token) }
        }
        KeychainStore.remove(AppStorageKey.authToken)
        UserDefaults.standard.removeObject(forKey: AppStorageKey.userEmail)
        UserDefaults.standard.set(false, forKey: AppStorageKey.hasOnboarded)
        isAuthenticated = false
        currentNonce = nil
        oauthState = nil
        // Drop any per-user cached state so the next account starts clean.
        clearUserCaches()
    }

    /// POST /auth/v1/logout to invalidate the refresh/session server-side. Best-effort.
    private func revokeSupabaseSession(_ token: String) async {
        guard let url = URL(string: "\(Config.supabaseURL)/auth/v1/logout") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: req)
    }

    /// Clear caches that are scoped to the signed-in user. Cached Apple email entries (keyed by the
    /// Apple user id) are intentionally retained so re-sign-in keeps the same email.
    private func clearUserCaches() {
        URLCache.shared.removeAllCachedResponses()
    }

    /// Exchange the Apple identity token for a Supabase session (live JWT path). On success stores
    /// the JWT and completes onboarding; on failure surfaces an error and does NOT sign the user in.
    private func exchangeWithSupabase(idToken: String) async {
        guard let url = URL(string: "\(Config.supabaseURL)/auth/v1/token?grant_type=id_token") else {
            errorMessage = "Couldn't sign you in. Please try again."
            return
        }
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
              let token = json["access_token"] as? String else {
            // No JWT → not signed in. Surface a generic error rather than leaving a half state.
            errorMessage = "Couldn't sign you in. Please try again."
            return
        }
        KeychainStore.set(token, for: AppStorageKey.authToken)
        isAuthenticated = true
        errorMessage = nil
    }

    /// Map raw Supabase/GoTrue error strings to safe, user-facing copy.
    private static func friendlyAuthError(_ raw: String?, status: Int, isSignup: Bool) -> String {
        let lower = (raw ?? "").lowercased()
        // Confirmation is still ON server-side: check this BEFORE the generic 400 handler.
        if lower.contains("not confirmed") || lower.contains("confirm your email") {
            return "Check your email to confirm your account, then sign in."
        }
        if lower.contains("already registered") || lower.contains("already been registered") || status == 422 {
            return "That email is already registered. Try signing in instead."
        }
        if lower.contains("invalid login") || lower.contains("invalid") || status == 400 || status == 401 {
            return isSignup ? "Couldn't create the account. Check your details and try again." : "Wrong email or password."
        }
        if lower.contains("rate") || status == 429 {
            return "Too many attempts. Please wait a moment and try again."
        }
        return isSignup ? "Couldn't create the account." : "Wrong email or password."
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
