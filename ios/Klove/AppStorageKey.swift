import Foundation

/// Centralized @AppStorage / UserDefaults keys so the string isn't duplicated across the app.
enum AppStorageKey {
    /// Mock-mode identity until Supabase Auth lands; sent as the `x-user-email` header.
    static let userEmail = "userEmail"
    /// Whether the user has completed the onboarding flow.
    static let hasOnboarded = "hasOnboarded"
}
