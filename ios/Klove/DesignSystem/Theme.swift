import SwiftUI

/// Klove visual language. Calm, not clinical: light/airy paper backgrounds, a warm NON-blue accent
/// (deliberately avoiding the generic health-app blue), and high-contrast, readable type for users
/// who may be older or stressed. Warm through competence — reassuring because it's in control.
enum Theme {
    // Warm, differentiated accent (terracotta) — signals trust without the clinical-portal cliché.
    static let accent = Color(red: 0.78, green: 0.36, blue: 0.24)
    static let accentSoft = Color(red: 0.78, green: 0.36, blue: 0.24).opacity(0.12)

    // Light paper backgrounds.
    static let background = Color(red: 0.98, green: 0.97, blue: 0.95)
    static let surface = Color.white
    static let surfaceSunken = Color(red: 0.96, green: 0.95, blue: 0.93)

    // Ink-on-paper text for strong contrast.
    static let ink = Color(red: 0.16, green: 0.14, blue: 0.13)
    static let inkSecondary = Color(red: 0.40, green: 0.37, blue: 0.35)

    // Status accents for the Today briefing buckets.
    static let needsYou = Color(red: 0.80, green: 0.45, blue: 0.16) // amber — action
    static let waiting = Color(red: 0.55, green: 0.52, blue: 0.49) // sand grey — pending
    static let handled = Color(red: 0.36, green: 0.52, blue: 0.40) // muted green — done

    static let cornerRadius: CGFloat = 16
}

/// A calm card surface used across briefing, family, and member screens.
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                    .stroke(Theme.ink.opacity(0.06), lineWidth: 1)
            )
            .shadow(color: Theme.ink.opacity(0.04), radius: 8, x: 0, y: 2)
    }
}

extension View {
    /// Wrap content in a Klove card surface.
    func kloveCard() -> some View { modifier(CardModifier()) }

    /// Apply the Klove background to a screen.
    func kloveBackground() -> some View {
        background(Theme.background.ignoresSafeArea())
    }
}
