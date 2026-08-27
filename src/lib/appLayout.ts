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

/// The row's edge inset, per design variant: the space before the name and
/// after the count.
const SIDEBAR_ROW_PAD_PX: Record<DesignMode, number> = {
  default: 0,
  alt: 16,
  alt2: 16,
};

/// The nav's own inset from the panel edges, per design variant.
const SIDEBAR_NAV_PAD_PX: Record<DesignMode, number> = {
  default: 32,
  alt: 0,
  alt2: 0,
};

/// The zone the meta column occupies, measured from the guideline to the panel
/// edge: the button's field, the button, and the field between button and
/// guideline.
function sidebarActionZone(design: DesignMode): number {
  const inset = Math.max(SIDEBAR_ROW_PAD_PX[design] - SIDEBAR_ROW_ACTION_GAP_PX, 0);
  return inset + SIDEBAR_ROW_ACTION_BUTTON_PX + SIDEBAR_ROW_ACTION_GAP_PX;
}

/// The width of one visual zone — what the eye compares.
///
/// A zone is the distance between two guidelines (or between a guideline and
/// the panel edge), so it carries the row's padding and the gaps around the
/// previews, not just a column box. Measuring boxes instead left the middle
/// zone visibly narrower than its neighbours even when the boxes agreed.
///
/// It is the larger of what the name needs (its padding plus the keystone
/// column) and what the action button occupies, so no zone has to shrink below
/// what it holds.
export function sidebarZoneWidth(design: DesignMode): number {
  return Math.max(
    SIDEBAR_ROW_PAD_PX[design] + SIDEBAR_COLUMN_MIN_PX,
    sidebarActionZone(design),
  );
}

/// Where the name column bottoms out: its zone without the row's own padding.
export function sidebarNameFloor(design: DesignMode): number {
  return sidebarZoneWidth(design) - SIDEBAR_ROW_PAD_PX[design];
}

/// Everything in the row that is not the name+previews flex region: the meta
/// zone, the two guideline pixels, and the row's left inset.
export function sidebarReserved(design: DesignMode): number {
  return sidebarZoneWidth(design) + 2 + SIDEBAR_ROW_PAD_PX[design];
}

/** Minimum panel width: the point where the three visual zones are equal. */
export function sidebarMinWidth(design: DesignMode): number {
  // Three zones, the two guidelines between them, and the nav's own insets.
  return sidebarZoneWidth(design) * 3 + 2 + SIDEBAR_NAV_PAD_PX[design] * 2;
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
