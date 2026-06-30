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

// Everything in the row that is NOT the name+icons flex region: the meta column
// (88) plus the fixed paddings/gap, which differ by design variant.
//   default: meta 88 + nav-pad 32×2 + divider-gap 4 = 156
//   alt:     meta 88 + row-pad 16    + divider-gap 4 = 108
const SIDEBAR_RESERVED_PX: Record<DesignMode, number> = {
  default: 156,
  alt: 108,
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
