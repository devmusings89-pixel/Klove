import SwiftUI
import UIKit

/// Klove visual language — V1 "editorial monochrome". Calm and confident: near-white paper, ink-black
/// type and accents, soft grey cards, serif display headings (the Klove voice) and tracked-uppercase
/// labels. No clinical blue, no warm terracotta — the product reads as quiet, premium, and in control.
///
/// Every color is adaptive (light + dark). The light appearance matches the Figma 1:1; the dark
/// appearance is a derived grayscale inversion so the whole app — including the booking flow — reads as
/// one product in either appearance. Spacing, radius, tracking, and type are tokenized so screens
/// compose from a shared rhythm instead of hand-rolled magic numbers.
enum Theme {
    // MARK: Colors (adaptive light/dark)

    /// Primary accent is now ink-black (light) / near-white (dark): the FAB, primary buttons, selected
    /// pills and tabs all derive from this. Changing this one token re-skins every interactive surface.
    static let accent = dynamic(
        light: Color(red: 0.10, green: 0.10, blue: 0.10),  // ~#1A1A1A ink
        dark: Color(red: 0.96, green: 0.95, blue: 0.94)    // near-white on black
    )
    /// Soft neutral fill for unselected pills / quiet backgrounds.
    static let accentSoft = dynamic(
        light: Color(red: 0.10, green: 0.10, blue: 0.10).opacity(0.06),
        dark: Color.white.opacity(0.12)
    )

    /// Near-white paper background → warm near-black in dark mode.
    static let background = dynamic(
        light: Color(red: 0.99, green: 0.99, blue: 0.98),  // ~#FCFCFB
        dark: Color(red: 0.07, green: 0.07, blue: 0.07)
    )
    /// Card / container surface (white) → elevated warm grey in dark mode.
    static let surface = dynamic(
        light: Color.white,
        dark: Color(red: 0.13, green: 0.13, blue: 0.12)
    )
    /// Secondary, recessed surface — the light-grey "what this means" info panels.
    static let surfaceSunken = dynamic(
        light: Color(red: 0.95, green: 0.95, blue: 0.94),  // ~#F2F2F0
        dark: Color(red: 0.18, green: 0.18, blue: 0.17)
    )

    /// Ink-on-paper text for strong contrast → warm off-white in dark mode.
    static let ink = dynamic(
        light: Color(red: 0.11, green: 0.11, blue: 0.10),
        dark: Color(red: 0.95, green: 0.94, blue: 0.92)
    )
    static let inkSecondary = dynamic(
        light: Color(red: 0.45, green: 0.44, blue: 0.43),  // ~#737271
        dark: Color(red: 0.66, green: 0.65, blue: 0.63)
    )

    // Status accents for the Today briefing buckets. The V1 design drops the old tri-color scheme in
    // favor of monochrome, so these now resolve to ink/greys — names are kept so existing call sites
    // (TodayView, ActionsView, task cards) compile unchanged.
    static let needsYou = ink           // action — strongest ink
    static let waiting = inkSecondary   // pending — quiet grey
    static let handled = inkSecondary   // done — quiet grey

    /// Subtle hairline used for card borders/dividers (adapts with ink).
    static let hairline = dynamic(
        light: Color(red: 0.11, green: 0.11, blue: 0.10).opacity(0.10),
        dark: Color.white.opacity(0.12)
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
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
    }

    // MARK: Letter spacing (tracking)

    enum Tracking {
        /// Tracked-uppercase section labels (NEEDS YOUR ATTENTION, THE TREND, …).
        static let label: CGFloat = 1.4
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
// Backed by system text styles so Dynamic Type keeps working. Display headings use Apple's New York
// (the `.serif` design) — the Klove voice — while labels/body stay on SF. Screens use these instead of
// hand-rolling `.caption.weight(.semibold)` everywhere, which keeps weights/sizes consistent and makes
// contrast guarantees enforceable.

extension Font {
    /// Large screen/brand display title (serif). e.g. "Good morning, Alyssa."
    static var kloveTitle: Font { .system(.largeTitle, design: .serif).weight(.semibold) }
    /// Italic serif companion line for the display title. e.g. "Here's your brief."
    static var kloveTitleItalic: Font { .system(.largeTitle, design: .serif).weight(.regular).italic() }
    /// Serif heading for record/sheet titles. e.g. "Hemoglobin A1c", "ask klove."
    static var kloveSerifHeading: Font { .system(.title2, design: .serif).weight(.semibold) }
    /// Card / sheet title (sans).
    static var kloveHeading: Font { .title3.weight(.semibold) }
    /// Section header above a group of cards (sans). Prefer `SectionLabel` for the tracked-caps style.
    static var kloveSectionHeader: Font { .headline }
    /// Tracked-uppercase label face (pair with `.textCase(.uppercase)` + `.tracking(Theme.Tracking.label)`).
    static var kloveLabel: Font { .caption.weight(.semibold) }
    /// Primary body / row title.
    static var kloveBody: Font { .subheadline }
    /// Emphasized body / row title.
    static var kloveBodyStrong: Font { .subheadline.weight(.semibold) }
    /// Secondary supporting text.
    static var kloveCaption: Font { .caption }
    /// Filled-button label — kept at subheadline so white-on-ink stays legible/AA-compliant.
    static var kloveButton: Font { .subheadline.weight(.semibold) }
}

// MARK: - Surfaces

/// A calm white card surface used across briefing, family, and member screens.
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
            .shadow(color: Color.black.opacity(0.04), radius: 6, x: 0, y: 1)
    }
}

/// A recessed, borderless grey panel — the "what this means" / info block style.
struct SunkenCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(Theme.Spacing.lg)
            .background(Theme.surfaceSunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
    }
}

extension View {
    /// Wrap content in a Klove card surface.
    func kloveCard() -> some View { modifier(CardModifier()) }

    /// Wrap content in a recessed grey info panel.
    func kloveCardSunken() -> some View { modifier(SunkenCardModifier()) }

    /// Apply the Klove background to a screen.
    func kloveBackground() -> some View {
        background(Theme.background.ignoresSafeArea())
    }
}

// MARK: - Primary button

/// Full-width ink-filled CTA — "Ask Klove about this", "Add to Mom's brief".
struct KlovePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.kloveButton)
            .foregroundStyle(Theme.background)        // paper-on-ink (inverts cleanly in dark)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}
