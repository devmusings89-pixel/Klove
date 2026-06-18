import SwiftUI

/// The single canonical task card — identical on the Today summary, the Actions log, and the Action
/// detail header. `TaskCardBody` is the shared content; `TaskCard` wraps it in a card surface, and
/// the actionable variant adds buttons below the same body. One component = one look everywhere.
struct TaskCard: View {
    let task: KloveTask
    var body: some View { TaskCardBody(task: task).kloveCard() }
}

/// Card content (no surface) so it can be reused inside the actionable card with buttons.
struct TaskCardBody: View {
    let task: KloveTask

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Label(task.memberName ?? "You", systemImage: task.kindSymbol)
                    .labelStyle(.titleAndIcon)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.accent)
                Spacer()
                TaskStatusPill(task: task)
            }

            Text(task.displayTitle)
                .font(.headline)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)

            // Structured content by type, in priority order.
            if let b = task.booking {
                BookingConfirmationBlock(booking: b)
            } else if let f = task.followUp {
                FollowUpBlock(followUp: f)
            } else if task.isChooseTime, let opts = task.options, !opts.isEmpty {
                ChooseTimeHint(count: opts.count)
            } else if let detail = task.detail, !detail.isEmpty {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Structured blocks

/// A reusable "labeled rows on a sunken surface, tinted banner on top" block.
private struct InfoBlock<Content: View>: View {
    let tint: Color
    let bannerIcon: String
    let bannerText: String
    @ViewBuilder var rows: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: bannerIcon)
                Text(bannerText)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 8) { rows }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// One icon + text row used inside the structured blocks.
struct DetailRow: View {
    let icon: String
    let text: String
    var mono: Bool = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon).font(.footnote).foregroundStyle(Theme.inkSecondary).frame(width: 18)
            Text(text).font(mono ? .subheadline.monospaced() : .subheadline).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
        }
    }
}

/// Booking confirmation: status banner + When / With / Confirmation rows.
struct BookingConfirmationBlock: View {
    let booking: BookingInfo
    var body: some View {
        InfoBlock(
            tint: booking.verified ? Theme.handled : Theme.needsYou,
            bannerIcon: booking.verified ? "checkmark.seal.fill" : "clock.badge.exclamationmark.fill",
            bannerText: booking.verified ? "Confirmed" : "Provisional hold — not yet confirmed"
        ) {
            DetailRow(icon: "calendar", text: booking.whenDisplay)
            if let p = booking.provider, !p.isEmpty { DetailRow(icon: "stethoscope", text: p) }
            if let c = booking.confirmation, !c.isEmpty { DetailRow(icon: "number", text: c, mono: true) }
        }
    }
}

/// Health-insight follow-up: recommended action + who + by-when + the guideline citation.
struct FollowUpBlock: View {
    let followUp: FollowUpInfo
    var body: some View {
        InfoBlock(tint: Theme.accent, bannerIcon: followUp.icon, bannerText: followUp.actionLabel) {
            if let s = followUp.recommendedSpecialty, !s.isEmpty { DetailRow(icon: "person.text.rectangle", text: s.capitalized) }
            if let d = followUp.daysToAction { DetailRow(icon: "clock", text: "Within about \(d) days") }
            if let g = followUp.guideline, !g.isEmpty { DetailRow(icon: "checkmark.shield", text: g) }
        }
    }
}

/// Compact hint for a choose-time task (the picker lives on the detail screen).
struct ChooseTimeHint: View {
    let count: Int
    var body: some View {
        InfoBlock(tint: Theme.needsYou, bannerIcon: "calendar.badge.clock", bannerText: "\(count) time\(count == 1 ? "" : "s") to choose from") {
            DetailRow(icon: "hand.tap", text: "Tap to pick the one that works")
        }
    }
}

/// Status chip. Booking tasks read "Confirmed"/"Hold"; other tasks show their workflow state.
/// A provisional hold is emphasized (ink fill) to draw the eye; everything else is a quiet grey chip.
struct TaskStatusPill: View {
    let task: KloveTask
    private var label: String {
        if let b = task.booking { return b.verified ? "Confirmed" : "Hold" }
        return task.state.replacingOccurrences(of: "_", with: " ")
    }
    private var emphasized: Bool {
        if let b = task.booking { return !b.verified }
        return task.state == "needs_you"
    }
    var body: some View {
        StatusChip(text: label, emphasized: emphasized)
    }
}
