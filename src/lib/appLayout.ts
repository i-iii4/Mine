import { currentChromeRowHeight, tabBarLeadWidthPx } from "./chromeHeight";
import { EDGE_FADE_WIDTH } from "./edgeFade";

// The widths a window is laid out by (SPEC_NARROW_WINDOW.md, «Величины»).
// The backend owns the ones it needs itself: SIDEBAR_MIN_WIDTH_PX,
// WINDOW_MIN_WIDTH_PX (and APP_MAIN_MIN_WIDTH_PX, the same value) and
// SIDEBAR_OVERLAY_STRIP_PX live in
// src-tauri/src/domain/windows.rs, which sets the window's minimum from them.
// They are restated here once, and appLayout.test.ts reads the Rust source to
// keep the two equal.

/** Narrowest the page gets: the window's minimum, a common phone's layout
 *  (user's decision of 16.10.2026; SPEC_NARROW_WINDOW.md, У3;
 *  domain/windows.rs `WINDOW_MIN_WIDTH_PX`). The sidebar lies over the feed
 *  there. */
export const APP_MIN_WIDTH_PX = 390;
/** Narrowest the feed gets beside the sidebar (`F_min`): always the window's
 *  narrowest, one value for both (user's decision of 16.10.2026;
 *  domain/windows.rs `APP_MAIN_MIN_WIDTH_PX`). */
export const APP_MAIN_MIN_WIDTH_PX = APP_MIN_WIDTH_PX;
/** The strip the sidebar leaves at the right when it lies over the feed
 *  (`STRIP`, domain/windows.rs `SIDEBAR_OVERLAY_STRIP_PX`). */
export const SIDEBAR_OVERLAY_STRIP_PX = 40;
/** Narrowest the sidebar gets (`S_min`): the narrowest window less the strip,
 *  so the sidebar over the feed of the narrowest window is exactly this wide
 *  (user's decision of 16.10.2026; domain/windows.rs `SIDEBAR_MIN_WIDTH_PX`).
 *  The rows' three equal zones (`sidebarEqualZonesWidth()`) are a layout of
 *  their own, never wider than this. */
export const SIDEBAR_MIN_WIDTH_PX = APP_MIN_WIDTH_PX - SIDEBAR_OVERLAY_STRIP_PX;
/** Widest a drag takes the sidebar (`S_max`). */
export const SIDEBAR_MAX_WIDTH_PX = 600;

// ── Sidebar column model ─────────────────────────────────────────────────────
// One keystone width unifies three things at the minimum: 2.5 preview icons
// (icon32 + gap4 + icon32 + gap4 + half16 = 88), the meta column, and the
// equal-columns target. At the minimum width all three columns equal this.
export const SIDEBAR_COLUMN_MIN_PX = 88;
// Name column caps here on wide panels; the surplus goes to the icon strip.
export const SIDEBAR_NAME_MAX_PX = 150;

/// Minimum width for the Connect / Connected / Disconnect control, wide enough
/// for the longest of the three so its cell does not twitch as it switches.
/// The sidebar fills its cell minus two equal fields; pickers use this width.
///
/// Pixels, not `ch`. It used to read `10ch` — ten zero-widths of the current
/// font — which tied a control's size to the typeface: Geist at 14px happened
/// to give 81.95, while the column framing it was measured in pixels, so the
/// button sat about 2px off centre and any change of face or size would have
/// moved it again. A control has a size; it does not take one from its text.
/// Lives here because both the sidebar row and the collection picker draw this
/// control and must not drift apart.
export const SIDEBAR_ROW_ACTION_BUTTON_PX = 84;
/// The look of that control: one `Connect` in the sidebar row and the picker,
/// so the two never differ in padding or type. Filled with depth like the
/// app's buttons, regular weight; hover lays the state layer over the face
/// (buttons.css) and the text stays as it is (DESIGN_SYSTEM.md, «Объём
/// кнопки»).
export const CONNECT_ACTION_BUTTON_CLASS =
  "button-depth inline-flex h-6 items-center justify-center rounded-1 bg-depth-fill px-[1ch] font-sans text-sm font-normal text-foreground outline-0 outline-transparent focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover";
/// The breathing space between that control and the column that frames it.
export const SIDEBAR_ROW_ACTION_GAP_PX = 8;

/// Clear pixels after the row's guideline, before the thumbnails begin.
export const SIDEBAR_PREVIEW_DIVIDER_GAP_PX = 4;

/// How many tiles one sidebar thumbnail strip holds: the preview read asks for
/// this many cards per collection, and a strip still waiting for that read
/// draws at most this many placeholder tiles. Even the widest panel shows
/// fewer; the rest sit past the strip's clipped, faded edge, exactly where the
/// real thumbnails will sit.
export const SIDEBAR_PREVIEW_SLOTS = 20;

/// The row's edge inset: the space before the name and after the count
/// (global.css, `--sidebar-row-pad-x`).
const SIDEBAR_ROW_PAD_PX = 16;

/// The nav's own inset from the panel edges: the table sits flush to them
/// (global.css, `--sidebar-nav-pad-x`).
const SIDEBAR_NAV_PAD_PX = 0;

/// The zone the meta column occupies, measured from the guideline to the panel
/// edge: the button's field, the button, and the field between button and
/// guideline.
function sidebarActionZone(): number {
  return SIDEBAR_ROW_ACTION_BUTTON_PX + 2 * SIDEBAR_ROW_ACTION_GAP_PX;
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
export function sidebarZoneWidth(): number {
  return Math.max(
    SIDEBAR_ROW_PAD_PX + SIDEBAR_COLUMN_MIN_PX,
    sidebarActionZone(),
  );
}

/// Where the name column bottoms out: its zone without the row's own padding.
export function sidebarNameFloor(): number {
  return sidebarZoneWidth() - SIDEBAR_ROW_PAD_PX;
}

/// Everything in the row that is not the name+previews flex region: the meta
/// zone, the two guideline pixels, and the row's left inset.
export function sidebarReserved(): number {
  return sidebarZoneWidth() + 2 + SIDEBAR_ROW_PAD_PX;
}

/** The width at which the three visual zones of a row are equal: the rows'
 *  columns stop reflowing there, the nav holds it and a narrower panel clips
 *  it (`--sidebar-equal-zones-width`). The panel itself is never narrower than
 *  `SIDEBAR_MIN_WIDTH_PX`, which is at least this (16.10.2026), so the zones
 *  only meet the curtain in a panel's resize motion. */
export function sidebarEqualZonesWidth(): number {
  // Three zones, the two guidelines between them, and the nav's own insets.
  return sidebarZoneWidth() * 3 + 2 + SIDEBAR_NAV_PAD_PX * 2;
}

// ── Compact rows ────────────────────────────────────────────────────────────
// Experiment of 22.10.2026 (PLAN 50.36, DESIGN_SYSTEM.md, «Компактная строка
// боковой панели»): below a width the rows drop the three zones, the count goes
// under the name and the previews become the 7.23 stack of three mini-cards
// in the meta zone. The width is not chosen; it is where the previews stop
// showing three thumbnails clear of their edge.

/// One tile of the thumbnail strip (`size-8`) and the gap between two (`gap-1`).
const SIDEBAR_PREVIEW_TILE_PX = 32;
const SIDEBAR_PREVIEW_TILE_GAP_PX = 4;
/// The panel's own right border (`border-r` on the sidebar): the rows are this
/// much narrower than `--sidebar-width`.
const SIDEBAR_PANEL_BORDER_PX = 1;

/** The previews' cell that shows 2.8 thumbnails before its edge: the
 *  guideline's pixel and the divider gap before them, the three tiles and two
 *  gaps, the 24px dissolve the strip ends in (`EDGE_FADE_WIDTH`) and the
 *  divider gap the dark theme keeps after it (global.css, «Previews' right
 *  edge»). One geometry for both themes: the light theme cuts the strip where
 *  the dark one dissolves it. */
/// How many thumbnails the strip shows when the rows turn compact: 2.8
/// (user's decision of 22.10.2026), two whole tiles and most of a third.
const SIDEBAR_COMPACT_VISIBLE_THUMBNAILS = 2.8;

export function sidebarThreeThumbnailsCellPx(): number {
  const whole = Math.floor(SIDEBAR_COMPACT_VISIBLE_THUMBNAILS);
  const tiles = whole * (SIDEBAR_PREVIEW_TILE_PX + SIDEBAR_PREVIEW_TILE_GAP_PX)
    + (SIDEBAR_COMPACT_VISIBLE_THUMBNAILS - whole) * SIDEBAR_PREVIEW_TILE_PX;
  return 1 + SIDEBAR_PREVIEW_DIVIDER_GAP_PX + tiles + EDGE_FADE_WIDTH + SIDEBAR_PREVIEW_DIVIDER_GAP_PX;
}

/** The rows' width below which they are compact (the `sidebar-rows`
 *  container query in global.css). The previews' cell is what the row leaves
 *  after the name's zone and the meta zone with its guideline:
 *  `R − (pad + nameCol) − (1 + zone)`, and in the narrow panels this concerns
 *  the name's column is `floor + (W − equal)/2` with `W = R + border`
 *  (`--sidebar-name-col`). Solved for the cell that shows three thumbnails.
 *  MUST equal the number in global.css; `sidebarColumns.test.ts` holds both. */
export function sidebarCompactRowsBelowPx(): number {
  const cell = sidebarThreeThumbnailsCellPx();
  const rows = 2 * (cell + SIDEBAR_ROW_PAD_PX + sidebarNameFloor() + 1 + sidebarZoneWidth())
    + SIDEBAR_PANEL_BORDER_PX
    - sidebarEqualZonesWidth();
  // To a tenth of a pixel, as global.css writes it.
  return Math.round(rows * 10) / 10;
}

/** The name's column in rows `rowsWidth` wide, as `--sidebar-name-col` gives
 *  it from the panel's width. */
export function sidebarNameColumnPx(rowsWidth: number): number {
  const panel = rowsWidth + SIDEBAR_PANEL_BORDER_PX;
  return Math.min(SIDEBAR_NAME_MAX_PX, Math.max(sidebarNameFloor(), sidebarNameFloor() + (panel - sidebarEqualZonesWidth()) / 2));
}

/** The previews' cell in rows `rowsWidth` wide. */
export function sidebarPreviewCellPx(rowsWidth: number): number {
  return rowsWidth - (SIDEBAR_ROW_PAD_PX + sidebarNameColumnPx(rowsWidth)) - (1 + sidebarZoneWidth());
}

/** Narrowest the sidebar beside the feed gets (`S_beside`), where a drag of
 *  the edge and a narrow window's squeeze both stop: the tab bar's lead
 *  before the first tab and the panel's border, so the sidebar's edge stands
 *  under the first tab's line (user's decision of 22.10.2026). It follows the
 *  chrome's height: 169 at the standard row, 173.5 at the tall one. A width
 *  this narrow is always compact. domain/windows.rs restates the tall one,
 *  rounded up, as `SIDEBAR_BESIDE_MIN_WIDTH_PX`; appLayout.test.ts holds the
 *  two equal. */
export function sidebarBesideMinWidthPx(chromeRow: number = currentChromeRowHeight()): number {
  return tabBarLeadWidthPx(chromeRow) + SIDEBAR_PANEL_BORDER_PX;
}

/** The window's width below which the sidebar leaves the row and lies over the
 *  feed, and the whole window goes narrow (SPEC_NARROW_WINDOW.md, У1, У12,
 *  У13, У15): the narrowest sidebar beside the feed and the narrowest feed,
 *  `S_beside + F_min`. User's decision of 22.10.2026: the window goes narrow
 *  only once the sidebar, compact, can shrink no further (it was
 *  `S_min + F_min`, 740). */
export function sidebarOverlayBelowPx(chromeRow: number = currentChromeRowHeight()): number {
  return sidebarBesideMinWidthPx(chromeRow) + APP_MAIN_MIN_WIDTH_PX;
}

// The first-run width is the window's: the backend starts every window's
// sidebar at its SIDEBAR_DEFAULT_WIDTH_PX (SPEC_TABS.md, В56).
