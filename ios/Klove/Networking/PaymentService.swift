import SwiftUI
#if canImport(StripePaymentSheet)
import StripePaymentSheet
#endif

/// Presents Stripe's PaymentSheet for a one-time $5 session charge.
/// Falls back to the backend mock-payment endpoint when Stripe isn't configured.
@MainActor
enum PaymentService {
    enum Outcome { case completed, canceled, failed(String) }

    static var isStripeConfigured: Bool { !Config.stripePublishableKey.isEmpty }

    /// Drive payment for a created session. `response` carries the PaymentIntent client secret.
    static func pay(for response: CreateSessionResponse) async -> Outcome {
        // Mock mode: backend issued a fake secret; confirm directly.
        if response.mockPayment || !isStripeConfigured {
            do {
                try await APIClient().confirmMockPayment(id: response.sessionId)
                return .completed
            } catch {
                return .failed((error as? AppError)?.errorDescription ?? error.localizedDescription)
            }
        }

        #if canImport(StripePaymentSheet)
        STPAPIClient.shared.publishableKey = Config.stripePublishableKey
        var config = PaymentSheet.Configuration()
        config.merchantDisplayName = "Klove"
        let sheet = PaymentSheet(paymentIntentClientSecret: response.clientSecret, configuration: config)

        guard let presenter = topViewController() else {
            return .failed("Could not present payment screen.")
        }
        let result = await withCheckedContinuation { continuation in
            sheet.present(from: presenter) { continuation.resume(returning: $0) }
        }
        switch result {
        case .completed: return .completed
        case .canceled: return .canceled
        case .failed(let error): return .failed(error.localizedDescription)
        }
        #else
        return .failed("Stripe SDK not linked.")
        #endif
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
