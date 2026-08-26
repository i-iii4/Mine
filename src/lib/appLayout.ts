import type { DesignMode } from "@/lib/designMode";

export const APP_MAIN_MIN_WIDTH_PX = 304;
export const SIDEBAR_MAX_WIDTH_PX = 600;
export const APP_MIN_WIDTH_PX = SIDEBAR_MAX_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX;

// ── Sidebar column model ─────────────────────────────────────────────────────
// One keystone width unifies three things at the minimum: 2.5 preview icons
// (icon32 + gap4 + icon32 + gap4 + half16 = 88), the meta column, and the
// equal-columns target. At the minimum width all three columns equal this.
export const SIDEBAR_COLUMN_MIN_PX = 88;
// Name column caps here on wide panels; the surplus goes to the icon strip.
export const SIDEBAR_NAME_MAX_PX = 150;

/// Fixed width for the Connect / Connected / Disconnect control, wide enough
/// for the longest of the three so its cell does not twitch as it switches.
///
/// Pixels, not `ch`. It used to read `10ch` — ten zero-widths of the current
/// font — which tied a control's size to the typeface: Geist at 14px happened
/// to give 81.95, while the column framing it was measured in pixels, so the
/// button sat about 2px off centre and any change of face or size would have
/// moved it again. A control has a size; it does not take one from its text.
/// Lives here because both the sidebar row and the collection picker draw this
/// control and must not drift apart.
export const SIDEBAR_ROW_ACTION_BUTTON_PX = 84;
/// The breathing space between that control and the column that frames it.
export const SIDEBAR_ROW_ACTION_GAP_PX = 8;

/// Clear pixels after the row's guideline, before the thumbnails begin.
export const SIDEBAR_PREVIEW_DIVIDER_GAP_PX = 4;

/// The strip at the row's right edge that thumbnails may never enter: the
/// action button with its field on either side, the guideline's own pixel and
/// the divider gap after it. The button is invisible until hover but its room
/// is held always, so this is what the meta column actually costs.
///
/// It used to be assumed equal to SIDEBAR_COLUMN_MIN (88) while measuring 105,
/// and the 17px difference came out of the previews: at the minimum width the
/// visible thumbnail strip was 71 against 104 for the name, which read as a
/// middle column narrower than both its neighbours.
export const SIDEBAR_ROW_META_TAIL_PX =
  SIDEBAR_ROW_ACTION_GAP_PX
  + SIDEBAR_ROW_ACTION_BUTTON_PX
  + SIDEBAR_ROW_ACTION_GAP_PX
  + 1
  + SIDEBAR_PREVIEW_DIVIDER_GAP_PX;

// Everything in the row that is NOT the name+previews flex region: the meta
// tail (105) plus the fixed paddings, which differ by design variant.
//   default: tail 105 + nav-pad 32×2 = 169
//   alt:     tail 105 + row-pad 16   = 121
// Alt 2 is a copy of Alt 1 for now; it gets its own number the moment its
// row padding stops matching.
const SIDEBAR_RESERVED_PX: Record<DesignMode, number> = {
  default: SIDEBAR_ROW_META_TAIL_PX + 64,
  alt: SIDEBAR_ROW_META_TAIL_PX + 16,
  alt2: SIDEBAR_ROW_META_TAIL_PX + 16,
};

/** Minimum panel width: the point where name = icons = meta = SIDEBAR_COLUMN_MIN. */
export function sidebarMinWidth(design: DesignMode): number {
  return SIDEBAR_RESERVED_PX[design] + SIDEBAR_COLUMN_MIN_PX * 2;
}

/**
 * Below the minimum the panel becomes a curtain sliding over the frozen menu.
 * Collapse once it has slid roughly halfway across; releasing before that snaps
 * the menu back open to the minimum. (Tunable: the fraction of the curtain
 * travel before collapse.)
 */
export function sidebarCollapseThreshold(design: DesignMode): number {
  return Math.round(sidebarMinWidth(design) / 2);
}

/** Comfortable first-run / re-expand width, always at least the minimum. */
export function sidebarDefaultWidth(design: DesignMode): number {
  return Math.max(360, sidebarMinWidth(design));
}
