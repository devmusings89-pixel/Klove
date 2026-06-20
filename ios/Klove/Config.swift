import Foundation
import Security

/// App-wide configuration. `apiBaseURL` points at the deployed backend on Fly.io. Override per
/// environment via the Info.plist key `API_BASE_URL` (e.g. `http://localhost:8080` for local dev,
/// from a gitignored xcconfig) — otherwise it uses the production endpoint below.
enum Config {
    /// DEBUG-only launch-env override (used by the E2E QA harness to point the app at a local mock
    /// backend and disable Supabase so the dev `x-user-email` identity is accepted). Presence of the
    /// env var wins — even an empty value, which is how the harness *disables* Supabase. Release builds
    /// ignore this entirely.
    private static func envOverride(_ key: String) -> String? {
        #if DEBUG
        return ProcessInfo.processInfo.environment[key]
        #else
        return nil
        #endif
    }

    static var apiBaseURL: URL {
        if let env = envOverride("API_BASE_URL"), !env.isEmpty, let u = URL(string: env) { return u }
        let override = infoPlistString("API_BASE_URL")
        return URL(string: override.isEmpty ? defaultApiBaseURL : override)!
    }
    // NOTE: the custom domain agents.klovehealth.com currently serves a broken TLS cert (Fly reports
    // "Issued" but the edge serves no chain → iOS ATS *and* curl both fail). Point at the Fly-native
    // domain, which has a valid *.fly.dev cert. Switch back once the custom-domain cert is re-provisioned.
    private static let defaultApiBaseURL = "https://klove-backend.fly.dev"

    /// Stripe publishable key (safe to ship in the client). Use your test key `pk_test_…`.
    /// When empty, the app falls back to the backend's mock-payment endpoint.
    static let stripePublishableKey = ""

    /// Supabase project URL + publishable key for email/password, Apple, and Google sign-in.
    /// When empty, sign-in still works as a stable Apple-derived identity (dev header), no JWT.
    ///
    /// The `sb_publishable_…` key is the PUBLIC client key (Supabase's intended client credential,
    /// guarded by Row-Level Security) — it is designed to ship in the app, so it's safe to keep here
    /// as the default. The key that must NEVER be committed is the `service_role` secret, which the
    /// client never uses. A deployment can still override these per-environment via the Info.plist
    /// keys `SUPABASE_URL` / `SUPABASE_ANON_KEY` (e.g. from a gitignored xcconfig):
    ///   <key>SUPABASE_URL</key><string>$(SUPABASE_URL)</string>
    ///   <key>SUPABASE_ANON_KEY</key><string>$(SUPABASE_ANON_KEY)</string>
    static var supabaseURL: String {
        if let env = envOverride("SUPABASE_URL") { return env }   // present (even "") wins → "" disables Supabase
        let override = infoPlistString("SUPABASE_URL")
        return override.isEmpty ? defaultSupabaseURL : override
    }
    static var supabaseAnonKey: String {
        if let env = envOverride("SUPABASE_ANON_KEY") { return env }
        let override = infoPlistString("SUPABASE_ANON_KEY")
        return override.isEmpty ? defaultSupabaseAnonKey : override
    }

    private static let defaultSupabaseURL = "https://xgydnhqpsebszhpsbgaq.supabase.co"
    private static let defaultSupabaseAnonKey = "sb_publishable_DNABaw-IpsT8PMGFxTgLpA_Bu1QllqC"

    /// Read a string from the app bundle's Info.plist, trimming whitespace. Returns "" if absent.
    private static func infoPlistString(_ key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

/// Minimal Keychain wrapper for storing sensitive secrets (auth JWTs) outside UserDefaults.
/// Items are stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` so they never sync to
/// iCloud Keychain or other devices and are only readable while the device is unlocked.
enum KeychainStore {
    private static let service = "app.klove.client"

    static func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        // Replace any existing item: delete then add (simplest correct upsert).
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    static func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
