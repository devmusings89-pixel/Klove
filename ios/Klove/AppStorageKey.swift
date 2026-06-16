import Foundation

/// Centralized @AppStorage / UserDefaults keys so the string isn't duplicated across the app.
enum AppStorageKey {
    /// Mock-mode / fallback identity; sent as the `x-user-email` header when no bearer token.
    static let userEmail = "userEmail"
    /// Supabase session JWT (when signed in via Sign in with Apple → Supabase); sent as Bearer.
    static let authToken = "authToken"
    /// Whether the user has completed the onboarding flow.
    static let hasOnboarded = "hasOnboarded"
}
