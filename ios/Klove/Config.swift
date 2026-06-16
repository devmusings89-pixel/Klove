import Foundation

/// App-wide configuration. Point `apiBaseURL` at your running backend
/// (use your machine's LAN IP or an ngrok URL when testing on a device).
enum Config {
    static let apiBaseURL = URL(string: "http://localhost:8080")!

    /// Stripe publishable key (safe to ship in the client). Use your test key `pk_test_…`.
    /// When empty, the app falls back to the backend's mock-payment endpoint.
    static let stripePublishableKey = ""
}
