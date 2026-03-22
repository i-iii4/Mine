import SwiftUI

/// Design tokens from DESIGN_SYSTEM.md — pixel-perfect match with desktop.
enum Arena {
    // ── Colors (dark theme, oklch neutral grays) ──────────────────────────
    static let bg = Color(white: 0.049)            // #0C0C0C — oklch(0.1567)
    static let border = Color(white: 0.10)          // oklch(0.2311) — all borders
    static let fg = Color(white: 0.894)             // #E4E4E4 — primary text
    static let muted = Color(white: 0.533)          // #888888 — secondary text
    static let tertiary = Color(white: 0.333)       // #555555 — tertiary text

    // ── Spacing ──────────────────────────────────────────────────────────
    static let cardPadding: CGFloat = 16            // p-4
    static let gridGap: CGFloat = 8                 // adapted from 32px desktop
    static let mediaGap: CGFloat = 2                // gap-0.5
    static let textToMedia: CGFloat = 12            // mt-3
    static let textToAuthor: CGFloat = 8            // mt-2
    static let titleToBody: CGFloat = 6             // mt-1.5

    // ── Typography ───────────────────────────────────────────────────────
    static let textSm: CGFloat = 10                 // adapted from 12px desktop
    static let lineHeight: CGFloat = 16             // line-height for text-sm

    static func fontRegular(_ size: CGFloat = textSm) -> Font {
        .system(size: size, weight: .regular)
    }
    static func fontSemibold(_ size: CGFloat = textSm) -> Font {
        .system(size: size, weight: .semibold)
    }
}
