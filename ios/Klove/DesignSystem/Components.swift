import SwiftUI

// Shared building blocks for the V1 "editorial monochrome" design. Kept in one file so the whole
// design vocabulary — section labels, avatars, filter pills, status chips, segmented control, trend
// bars — lives next to `Theme` and re-skins consistently from the same tokens.

// MARK: - Section label

/// Tracked-uppercase section header with an optional trailing count.
/// e.g. `NEEDS YOUR ATTENTION                    2`
struct SectionLabel: View {
    let title: String
    var count: Int? = nil

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.kloveLabel)
                .textCase(.uppercase)
                .tracking(Theme.Tracking.label)
                .foregroundStyle(Theme.inkSecondary)
            Spacer(minLength: 0)
            if let count {
                Text("\(count)")
                    .font(.kloveLabel)
                    .foregroundStyle(Theme.inkSecondary)
            }
        }
    }
}

// MARK: - Initials

/// First-letter initials for an avatar, derived deterministically from a display name.
func kloveInitials(_ name: String) -> String {
    let parts = name.split(separator: " ").prefix(2)
    let letters = parts.compactMap { $0.first.map(String.init) }
    return letters.joined().uppercased().ifEmptyFallback("•")
}

private extension String {
    func ifEmptyFallback(_ fallback: String) -> String { isEmpty ? fallback : self }
}

// MARK: - Avatar chip

/// A rounded-square avatar tile. Shows a category `symbol` when provided (e.g. a drop for an A1c
/// result), otherwise the member's initials in serif. When both a symbol and `initials` are given, the
/// initials appear as a small badge in the corner — the Figma "category glyph + member initial" pattern.
struct AvatarChip: View {
    var initials: String = ""
    var symbol: String? = nil
    var size: CGFloat = 44

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(Theme.surfaceSunken)
                .frame(width: size, height: size)
                .overlay {
                    if let symbol {
                        Image(systemName: symbol)
                            .font(.system(size: size * 0.42, weight: .regular))
                            .foregroundStyle(Theme.ink)
                    } else {
                        Text(initials)
                            .font(.system(size: size * 0.40, design: .serif))
                            .foregroundStyle(Theme.ink)
                    }
                }

            if symbol != nil, !initials.isEmpty {
                Text(initials)
                    .font(.system(size: size * 0.26, weight: .semibold))
                    .foregroundStyle(Theme.background)
                    .frame(width: size * 0.42, height: size * 0.42)
                    .background(Theme.accent, in: Circle())
                    .overlay(Circle().stroke(Theme.surface, lineWidth: 1.5))
                    .offset(x: -size * 0.10, y: size * 0.10)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Member filter bar

/// Horizontal row of member pills (`All` + one per member) used atop the Today brief. The selection is
/// `nil` for "All", otherwise a member `userId`. Backed by `HouseholdStore.selectedMemberId` upstream.
struct MemberFilterBar: View {
    let members: [HouseholdMember]
    /// nil == "All members".
    @Binding var selection: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                pill(label: "All", initials: nil, isSelected: selection == nil) { selection = nil }
                ForEach(members) { m in
                    pill(label: shortName(m),
                         initials: kloveInitials(m.name),
                         isSelected: selection == m.userId) { selection = m.userId }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func shortName(_ m: HouseholdMember) -> String {
        if m.memberType == "self" { return "You" }
        return String(m.name.split(separator: " ").first ?? "")
    }

    @ViewBuilder
    private func pill(label: String, initials: String?, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let initials {
                    Text(initials)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(isSelected ? Theme.accent : Theme.ink)
                        .frame(width: 22, height: 22)
                        .background(isSelected ? Theme.background : Theme.surfaceSunken, in: Circle())
                }
                Text(label)
                    .font(.kloveBodyStrong)
            }
            .foregroundStyle(isSelected ? Theme.background : Theme.ink)
            .padding(.leading, initials == nil ? 16 : 6)
            .padding(.trailing, 16)
            .padding(.vertical, 6)
            .frame(minHeight: 34)
            .background(isSelected ? Theme.accent : Theme.surface, in: Capsule())
            .overlay(Capsule().stroke(Theme.hairline, lineWidth: isSelected ? 0 : 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Status chip

/// A small neutral pill — "HIGH", "OVERDUE", "PROVISIONAL". `emphasized` inverts to an ink fill.
struct StatusChip: View {
    let text: String
    var emphasized: Bool = false

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.6)
            .foregroundStyle(emphasized ? Theme.background : Theme.inkSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(emphasized ? Theme.accent : Theme.surfaceSunken, in: Capsule())
    }
}

// MARK: - Segmented control

/// A pill segmented control (Brief / Discussion, Timeline / Records, Connected / Found). Matches the
/// Figma pill style better than `UISegmentedControl`; the selected segment slides with a shared
/// geometry effect.
struct KloveSegmentedControl: View {
    let segments: [String]
    @Binding var selection: Int
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(segments.enumerated()), id: \.offset) { index, label in
                let isSelected = index == selection
                Button {
                    withAnimation(.snappy(duration: 0.22)) { selection = index }
                } label: {
                    Text(label)
                        .font(.kloveBodyStrong)
                        .foregroundStyle(isSelected ? Theme.ink : Theme.inkSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background {
                            if isSelected {
                                Capsule()
                                    .fill(Theme.surface)
                                    .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
                                    .matchedGeometryEffect(id: "seg", in: ns)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Theme.surfaceSunken, in: Capsule())
    }
}

// MARK: - Trend bars

/// A minimal grey bar chart with a value label above and a period label below each bar — the Records
/// detail "THE TREND" block. The most recent bar is emphasized with the ink accent.
struct TrendBars: View {
    struct Point: Identifiable, Hashable {
        let period: String   // "Jun '25"
        let value: Double    // numeric for bar height
        let display: String  // "6.7"
        var id: String { period }
    }

    let points: [Point]
    var barHeight: CGFloat = 70

    private var maxValue: Double { max(points.map(\.value).max() ?? 1, 0.0001) }

    var body: some View {
        HStack(alignment: .bottom, spacing: Theme.Spacing.lg) {
            ForEach(Array(points.enumerated()), id: \.element.id) { index, p in
                let isLast = index == points.count - 1
                VStack(spacing: 8) {
                    Text(p.display)
                        .font(.kloveCaption)
                        .foregroundStyle(Theme.inkSecondary)
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(isLast ? Theme.accent : Theme.surfaceSunken)
                        .frame(height: max(8, barHeight * CGFloat(p.value / maxValue)))
                    Text(p.period)
                        .font(.kloveCaption)
                        .foregroundStyle(Theme.inkSecondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity)
    }
}
