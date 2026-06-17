import SwiftUI
import UIKit

/// Klove visual language. Calm, not clinical: light/airy paper backgrounds, a warm NON-blue accent
/// (deliberately avoiding the generic health-app blue), and high-contrast, readable type for users
/// who may be older or stressed. Warm through competence — reassuring because it's in control.
///
/// Every color is adaptive (light + dark) so the whole app — including the booking flow — reads as
/// one product in either appearance. Spacing, radius, and type are tokenized so screens compose from
/// a shared rhythm instead of hand-rolled magic numbers.
enum Theme {
    // MARK: Colors (adaptive light/dark)

    /// Warm, differentiated accent (terracotta) — signals trust without the clinical-portal cliché.
    /// Slightly deepened from the original #C75C3D so white-on-accent clears WCAG AA (4.5:1) for the
    /// small, semibold labels used on filled buttons. Brightened in dark mode to stay vivid on black.
    static let accent = dynamic(
        light: Color(red: 0.71, green: 0.32, blue: 0.18),  // ~#B5512F
        dark: Color(red: 0.88, green: 0.46, blue: 0.32)    // brighter terracotta for dark surfaces
    )
    static let accentSoft = dynamic(
        light: Color(red: 0.71, green: 0.32, blue: 0.18).opacity(0.12),
        dark: Color(red: 0.88, green: 0.46, blue: 0.32).opacity(0.18)
    )

    /// Light paper background → warm near-black in dark mode.
    static let background = dynamic(
        light: Color(red: 0.98, green: 0.97, blue: 0.95),
        dark: Color(red: 0.09, green: 0.08, blue: 0.07)
    )
    /// Card / container surface (was pure white) → elevated warm grey in dark mode.
    static let surface = dynamic(
        light: Color.white,
        dark: Color(red: 0.15, green: 0.14, blue: 0.13)
    )
    /// Secondary, recessed surface.
    static let surfaceSunken = dynamic(
        light: Color(red: 0.96, green: 0.95, blue: 0.93),
        dark: Color(red: 0.20, green: 0.19, blue: 0.17)
    )

    /// Ink-on-paper text for strong contrast → warm off-white in dark mode.
    static let ink = dynamic(
        light: Color(red: 0.16, green: 0.14, blue: 0.13),
        dark: Color(red: 0.95, green: 0.94, blue: 0.92)
    )
    static let inkSecondary = dynamic(
        light: Color(red: 0.40, green: 0.37, blue: 0.35),
        dark: Color(red: 0.68, green: 0.65, blue: 0.62)
    )

    // Status accents for the Today briefing buckets — brightened in dark mode.
    static let needsYou = dynamic( // amber — action
        light: Color(red: 0.80, green: 0.45, blue: 0.16),
        dark: Color(red: 0.95, green: 0.62, blue: 0.30)
    )
    static let waiting = dynamic( // sand grey — pending
        light: Color(red: 0.55, green: 0.52, blue: 0.49),
        dark: Color(red: 0.66, green: 0.63, blue: 0.59)
    )
    static let handled = dynamic( // muted green — done
        light: Color(red: 0.36, green: 0.52, blue: 0.40),
        dark: Color(red: 0.52, green: 0.74, blue: 0.58)
    )

    /// Subtle hairline used for card borders/dividers (adapts with ink).
    static let hairline = dynamic(
        light: Color(red: 0.16, green: 0.14, blue: 0.13).opacity(0.06),
        dark: Color.white.opacity(0.10)
    )

    // MARK: Spacing scale

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 24
    }

    // MARK: Corner radius scale

    enum Radius {
        static let sm: CGFloat = 10
        static let md: CGFloat = 14
        static let lg: CGFloat = 16
    }

    /// Back-compat alias for the card radius (existing call sites use Theme.cornerRadius).
    static let cornerRadius: CGFloat = Radius.lg

    // MARK: Helpers

    /// Build a `Color` that resolves differently in light vs. dark appearance.
    private static func dynamic(light: Color, dark: Color) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
    }
}

// MARK: - Semantic typography
//
// Backed by system text styles so Dynamic Type keeps working. Screens use these instead of
// hand-rolling `.caption.weight(.semibold)` everywhere, which keeps weights/sizes consistent and
// makes contrast guarantees enforceable (e.g. button labels never drop below .subheadline).

extension Font {
    /// Large screen/brand title (serif — the Klove voice).
    static var kloveTitle: Font { .system(.largeTitle, design: .serif).weight(.semibold) }
    /// Card / sheet title.
    static var kloveHeading: Font { .title3.weight(.semibold) }
    /// Section header above a group of cards.
    static var kloveSectionHeader: Font { .headline }
    /// Primary body / row title.
    static var kloveBody: Font { .subheadline }
    /// Emphasized body / row title.
    static var kloveBodyStrong: Font { .subheadline.weight(.semibold) }
    /// Secondary supporting text.
    static var kloveCaption: Font { .caption }
    /// Filled-button label — kept at subheadline so white-on-accent stays legible/AA-compliant.
    static var kloveButton: Font { .subheadline.weight(.semibold) }
}

// MARK: - Surfaces

/// A calm card surface used across briefing, family, and member screens.
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(Theme.Spacing.lg)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .stroke(Theme.hairline, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.06), radius: 8, x: 0, y: 2)
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
