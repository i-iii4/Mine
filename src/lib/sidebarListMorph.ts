// The sidebar rows' change between the List look and the table across the
// compact threshold (user's decision of 01.11.2026; DESIGN_SYSTEM.md,
// «Переход между List и таблицей»). Going to the table the rows spread in one
// move from the List's step to the table's, each name riding with its row,
// never changing its size or its place across; the lines, the column guides,
// the strips and the counts show over the move's second half, and going back
// they fade within its first third while the rows gather. The List's own
// marks, its dotted leader and its count, do the mirror. One spring, the compact stack's (channelIcon.ts, through
// `morphSpring`); a crossing back mid-move turns it round from where it is,
// at the speed it had.
//
// The edge in hand moves the rows on the spring on every motion level: the
// move answers the drag (SPEC_MOTION_LEVELS.md, Р1, С3; user's decision of
// 15.11.2026). A width a command changes moves them by the level: the spring
// in Full, Перемещение in Minimal, 200 ms on the move curve from rest with
// the fades by the same shares of its time (РД4), at once at Off and after a
// key (Р3, Р4; sidebarLook.ts, `sidebarMorphMotion`).
//
// This module owns the scrollport's look (sidebarLook.ts): the attribute the
// stylesheet keys the compact rows on. At rest it follows the width; for a
// command at Off or after a key, under the narrow table (postponed) and
// when a frame moves the width across the threshold by more than a tile and
// its gap (the most one frame of ЛМ5 adds a tile for, user's decision of
// 01.11.2026) it changes at once. Otherwise the table is laid out for the whole move:
// going to it the scrollport takes the table's look in the frame that
// crossed, before it paints, so its strips take their whole count there
// (SPEC_SIDEBAR_STRIP.md, ЛМ2); going back it keeps the table until the
// rows stand where the List has them, and the List is laid out under them
// then (global.css, «List and table»). Keeping a look restyles nothing.
//
// Going to the table the List's places are read in the frame that crosses,
// where it is still laid out, and the table's once it takes its look. Going
// back the table's are read where it stands, and the List is laid out for
// the read alone: its names wrap by the width (List style Contents, fixed by
// the user's decision of 15.11.2026), so no places of it hold for another
// width. The frames of the
// move read nothing. Only the rows the move shows move: those whose way
// passes through the scrollport. Every part moves by `transform` alone and
// fades by `opacity` alone, by WAAPI. The frame that crosses only writes
// each moving part where it starts and lets the stylesheet start each
// fading part; the animations are made in the next frame, before its style
// pass, where the page's style is settled: a fade of a pseudo-element
// settles the style of its element when it is made, and a row's animation
// is read keyframe by keyframe in the style pass that takes it.
//
// A name's visible end is part of the move too (user's decisions of 01.11.2026
// and 05.11.2026): the landing lifts no cut and lays down no line. The List
// wraps a name, so its cell is laid out as the List lays it out for
// the whole move; a drag going on that changes a name's lines is the one thing
// the frames of the move read for, on the names that slide.

import { SIDEBAR_PREVIEW_TILE_GAP_PX, SIDEBAR_PREVIEW_TILE_PX, sidebarBesideMinWidthPx, sidebarCompactRowsBelowPx, sidebarNameColumnPx, sidebarPanelWidthPx, sidebarRowsWidthPx } from "./appLayout";
import { CHANNEL_ICON_SPRING_MS, SPRING_SAMPLES } from "./channelIcon";
import { getSidebarStyle } from "./compactStack";
import { MOTION_SPRING_MOVE_MS, type SpringMotion } from "./motion";
import { SIDEBAR_LOOK_ATTRIBUTE, SIDEBAR_WIDTH_MOTION_ATTRIBUTE, type SidebarLook, setSidebarLook, sidebarContentWidth, sidebarLookAt, sidebarLookOfPanel, sidebarMorphMotion } from "./sidebarLook";
import { animatesPseudoElements, morphMove, morphSpring, type MorphSpring } from "./sidebarRowsMorph";
import { holdStripWidths } from "./sidebarStripWidth";

// ─── Time ───────────────────────────────────────────────────────────────

/** The move's settling time from rest, ms: the stack spring's, 441. */
export const LIST_MORPH_SETTLE_MS = CHANNEL_ICON_SPRING_MS;

/** The first third of the move: the parts of the look being left are gone
 *  by its end (the card window's content, `CARD_PEEK_CONTENT_FADE_MS`). */
export const LIST_MORPH_FADE_OUT_MS = LIST_MORPH_SETTLE_MS / 3;

/** Halfway: the parts of the look being reached start to show from here
 *  (the card window's content, `CARD_PEEK_CONTENT_IN_FROM_MS`). */
export const LIST_MORPH_FADE_IN_FROM_MS = LIST_MORPH_SETTLE_MS / 2;

/** How a part fades: toward its look (`in`) or away from it (`out`). */
export type FadeWay = "in" | "out";

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

/** A fading part's share of its own opacity `elapsedMs` into a run that
 *  began with it at `from` and settles in `settleMs`: in, it holds where it
 *  was until halfway, then shows evenly up to the settling time; out, it is
 *  gone by the end of the first third. Full's run settles in
 *  `LIST_MORPH_SETTLE_MS`, Minimal's in Перемещение's time. The stylesheet's
 *  animations play the same (global.css, «List and table»). */
export function fadeShare(way: FadeWay, elapsedMs: number, from: number, settleMs: number = LIST_MORPH_SETTLE_MS): number {
  const outMs = settleMs * (LIST_MORPH_FADE_OUT_MS / LIST_MORPH_SETTLE_MS);
  const inFromMs = settleMs * (LIST_MORPH_FADE_IN_FROM_MS / LIST_MORPH_SETTLE_MS);
  if (way === "out") return from * clampUnit(1 - elapsedMs / outMs);
  return from + (1 - from) * clampUnit((elapsedMs - inFromMs) / (settleMs - inFromMs));
}

/** The keyframes WAAPI plays `fadeShare` by, linear between them. */
export interface FadeTrack {
  durationMs: number;
  frames: { offset: number; share: number }[];
}

export function fadeTrack(way: FadeWay, from: number, settleMs: number = LIST_MORPH_SETTLE_MS): FadeTrack {
  if (way === "out") {
    return { durationMs: settleMs * (LIST_MORPH_FADE_OUT_MS / LIST_MORPH_SETTLE_MS), frames: [{ offset: 0, share: from }, { offset: 1, share: 0 }] };
  }
  const half = LIST_MORPH_FADE_IN_FROM_MS / LIST_MORPH_SETTLE_MS;
  return {
    durationMs: settleMs,
    frames: [{ offset: 0, share: from }, { offset: half, share: from }, { offset: 1, share: 1 }],
  };
}

// ─── The move ───────────────────────────────────────────────────────────

/** One run of the move: the List-ness `q` (0 the table, 1 the List) from
 *  `q0` to `q1` on `spring`. */
export interface MoveSegment {
  q0: number;
  q1: number;
  spring: MorphSpring;
}

/** A run from `q0` toward `q1` that starts at `speed` (List-ness per
 *  second): from rest, the stack's own spring; Minimal's move (`"move"`)
 *  from rest whatever the speed (РД4). */
export function segmentToward(q0: number, q1: number, speed: number, motion: Exclude<SpringMotion, "instant"> = "spring"): MoveSegment {
  const span = q1 - q0;
  return { q0, q1, spring: motion === "move" ? morphMove() : morphSpring(span !== 0 ? speed / span : 0) };
}

/** A run's List-ness at evenly spaced times: the spring's own samples, the
 *  keyframes of every part that moves, linear between them, as the
 *  spring's `linear()` easing draws it. Keyframes, not that easing: the
 *  compositor plays linear keyframes, and an animation eased by `linear()`
 *  restyles its element on the main thread in every frame. */
export function moveCurve(segment: MoveSegment): { offset: number; q: number }[] {
  const { spring, q0, q1 } = segment;
  return Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => ({
    offset: index / SPRING_SAMPLES,
    q: q0 + spring.progress((index / SPRING_SAMPLES) * spring.durationMs) * (q1 - q0),
  }));
}

/** Where a run is `elapsedMs` in, and how fast it goes, per second. */
export function segmentAt(segment: MoveSegment, elapsedMs: number): { q: number; speed: number } {
  const span = segment.q1 - segment.q0;
  return { q: segment.q0 + segment.spring.progress(elapsedMs) * span, speed: segment.spring.speed(elapsedMs) * span };
}

// ─── The places ─────────────────────────────────────────────────────────

/** A row's place in one layout, px down the list's scrolled content: its
 *  box and the middle of its name's line (of the field's, or of its own
 *  box when it has neither). */
export interface RowPlace {
  top: number;
  bottom: number;
  anchor: number;
}

/** One layout of the list: its rows in order and how far it scrolls. */
export interface RowsLayout {
  rows: RowPlace[];
  maxScroll: number;
}

/** The first row a scrollport scrolled to `scroll` shows: the first whose
 *  bottom is below its top; -1 when there is none. */
export function firstShownRow(layout: RowsLayout, scroll: number): number {
  return layout.rows.findIndex((row) => row.bottom > scroll);
}

/** Where `other` scrolls so that the first row `shown`, the layout on
 *  screen scrolled to `scroll`, shows keeps its name where it is: the
 *  anchor. A list at its top stays at its top, the first row its anchor.
 *  Clamped to what `other` can scroll: at an end of the list the rows land
 *  at the nearest scroll it can take. */
export function anchoredScroll(shown: RowsLayout, other: RowsLayout, scroll: number): number {
  const anchor = firstShownRow(shown, scroll);
  const target = scroll <= 0 || anchor < 0 || !other.rows[anchor]
    ? scroll
    : other.rows[anchor].anchor - shown.rows[anchor]!.anchor + scroll;
  return Math.min(Math.max(0, target), Math.max(0, other.maxScroll));
}

/** Each row's move down the screen, px, from its place in the table,
 *  scrolled to `tableScroll`, to its place in the List, scrolled to
 *  `listScroll`: the transform that lays the table's row over the List's at
 *  List-ness 1. */
export function rowOffsets(list: RowsLayout, table: RowsLayout, listScroll: number, tableScroll: number): number[] {
  return table.rows.map((row, index) => (list.rows[index]!.anchor - listScroll) - (row.anchor - tableScroll));
}

/** The rows the move shows: those whose box, on its way from the table's
 *  place to the List's, crosses a scrollport `height` tall. */
export function rowsOnTheWay(table: RowsLayout, offsets: number[], tableScroll: number, height: number): number[] {
  const shown: number[] = [];
  table.rows.forEach((row, index) => {
    const offset = offsets[index] ?? 0;
    const top = row.top - tableScroll + Math.min(0, offset);
    const bottom = row.bottom - tableScroll + Math.max(0, offset);
    if (bottom > 0 && top < height) shown.push(index);
  });
  return shown;
}

/** How the List stands a row by its name's height, px from the
 *  row's top: the row's height, the middle of its first line, the top of its
 *  count. A row of one line is as the List lays it out (`one`); of more, its
 *  lines and its padding. */
export interface ListRowModel {
  line: number;
  pad: number;
  /** The middle of a name's first line, below its cell's top. */
  anchorInCell: number;
  one: { height: number; anchor: number; count: number };
}

export function listRowAt(model: ListRowModel, nameHeight: number): { height: number; anchor: number; count: number } {
  if (nameHeight < model.line * 1.5) return model.one;
  return { height: nameHeight + 2 * model.pad, anchor: model.pad + model.anchorInCell, count: model.pad + nameHeight - model.line };
}

// ─── What a width does ──────────────────────────────────────────────────

/** The most one frame may move the width across the threshold by for the
 *  rows to move: a tile and its gap, the most a frame of ЛМ5 adds one tile
 *  for (SPEC_SIDEBAR_STRIP.md). A larger step (a fast drag, Home and End, a
 *  window snapped) switches the look at once (user's decision of
 *  01.11.2026). */
export const LIST_MORPH_STEP_LIMIT_PX = SIDEBAR_PREVIEW_TILE_PX + SIDEBAR_PREVIEW_TILE_GAP_PX;

/** What a width of the list does. `idle`: the move does not apply (a
 *  command's width at Off or after a key, the narrow table below the
 *  threshold, a list not laid out); a
 *  move lands and the look follows the width at once. `rest`: no crossing;
 *  the look follows the width. `instant`: the width crossed the threshold
 *  by more than `LIST_MORPH_STEP_LIMIT_PX` in one frame; a move lands and
 *  the look follows the width at once. `start`: the width crossed the
 *  threshold. `turn`: it crossed back mid-move. `go-on`: the move goes on,
 *  whatever the width on its side, which changes no row's place. */
export type WidthStep = "idle" | "rest" | "instant" | "start" | "turn" | "go-on";

export function widthStep(input: {
  /** List below the threshold, and a width whose change moves the rows:
   *  the edge in hand, or a command's width where its level moves it. */
  active: boolean;
  threshold: number;
  width: number;
  /** The width before, `null` before the first or after the list was not laid out. */
  previous: number | null;
  /** Where the move on its way goes; `null` at rest. */
  movingToTable: boolean | null;
}): WidthStep {
  if (!input.active || input.width <= 0) return "idle";
  const table = input.width >= input.threshold;
  if (input.previous === null) return input.movingToTable === null ? "rest" : "go-on";
  const crossed = (input.previous >= input.threshold) !== table;
  if (crossed && Math.abs(input.width - input.previous) > LIST_MORPH_STEP_LIMIT_PX) return "instant";
  if (input.movingToTable !== null) return table === input.movingToTable ? "go-on" : "turn";
  return crossed ? "start" : "rest";
}

// ─── The DOM ────────────────────────────────────────────────────────────

/** On the scrollport while the rows move: the List's marks are drawn on the table. */
const MARKS_ATTRIBUTE = "data-sidebar-list-marks";
/** On it while the rows move: the look being reached, `table` or `list`;
 *  the stylesheet starts the fading parts by it. */
const FADE_ATTRIBUTE = "data-sidebar-rows-fade";
/** On the scrollport going back to the List once the table's own parts are
 *  gone, after the first third: the stylesheet takes them out of the
 *  layout, so the strips under the narrowing edge lay out no tiles for the
 *  frames that do not show them. Going to the table they are laid out from
 *  its first frame, the strips with their whole count (SPEC_SIDEBAR_STRIP.md,
 *  ЛМ2). */
const BARE_ATTRIBUTE = "data-sidebar-rows-bare";
/** On the scrollport in the frame the look changes at once, with no move
 *  (Off, a key, a step past the limit, a collapse or an opening): the rows'
 *  text takes its new colour in that frame, with no transition of its own
 *  (global.css). Taken off in the next frame, when nothing is left to
 *  transition. */
export const LOOK_SWITCHING_ATTRIBUTE = "data-sidebar-look-switching";

const ROW_SELECTOR = "[data-sidebar-rows] [data-sidebar-row-surface]";
/** What a row's place is the place of: its name's text, or a field's input. */
const ANCHOR_SELECTOR = "[data-sidebar-name-text], [data-sidebar-editable-row-body] input";
/** Connect, Disconnect and Connected: plates in the table, words in the
 *  List; the plates are the table's alone. */
const LINK_SELECTOR = ":scope > [data-sidebar-link-action], :scope > [data-sidebar-row-connected-pill][data-state='on']";
const COUNT_SELECTOR = "[data-sidebar-meta-count]";
const BODY_SELECTOR = "[data-sidebar-row-body]";
/** The List's marks while the rows move: empty elements of the row body as
 *  large as the body (Sidebar.tsx), the leader's and the count's (global.css).
 *  Their place properties change them alone: on the body they changed every
 *  element inside it, a style recalculation of the whole list in the frame
 *  that crossed; and they fade as elements, not as the body's
 *  pseudo-elements. */
const LIST_LEADER_SELECTOR = ':scope > [data-sidebar-list-mark="leader"]';
const LIST_COUNT_MARK_SELECTOR = ':scope > [data-sidebar-list-mark="count"]';
/** Where the List's count stands on a row while it moves: its
 *  place in the List from the row body's top and right edge, and its type.
 *  The table's count, another part, is the count element itself. */
const LIST_COUNT_TOP_PROPERTY = "--sidebar-list-count-top";
const LIST_COUNT_RIGHT_PROPERTY = "--sidebar-list-count-right";
const LIST_COUNT_FONT_PROPERTY = "--sidebar-list-count-font";
/** On the marks of each row the move shows: the List's count stands on them. */
const LIST_COUNT_ATTRIBUTE = "data-sidebar-list-count";
/** The strips' cells. */
const RAIL_SELECTOR = "[data-sidebar-preview-rail]";
/** A name's cell and its text. */
const NAME_CELL_SELECTOR = "[data-sidebar-name-cell]";
const NAME_TEXT_SELECTOR = "[data-sidebar-name-text]";
/** On a name's cell whose visible end slides through the move (global.css):
 *  one of the two looks can cut it. */
const NAME_SLIDE_ATTRIBUTE = "data-sidebar-name-slide";
/** On a name's cell the move does not slide but a drag going on could cut:
 *  going to the List, where the name lands whole, nothing cuts it meanwhile. */
const NAME_WHOLE_ATTRIBUTE = "data-sidebar-name-whole";
/** How far the List's name cell stops short of the panel's width, px. */
const NAME_LIST_INSET_PROPERTY = "--sidebar-name-list-inset";
/** How tall the name's cell is in the List, px. */
const NAME_LIST_HEIGHT_PROPERTY = "--sidebar-name-list-h";
/** The mask's end in each look, as CSS. */
const NAME_EDGE_TABLE_PROPERTY = "--sidebar-name-edge-table";
const NAME_EDGE_LIST_PROPERTY = "--sidebar-name-edge-list";
/** List-ness of the name's visible end: 0 the table's, 1 the List's. */
const NAME_Q_PROPERTY = "--sidebar-name-q";
/** The column guides, also the element the run's clock runs on: it has no
 *  content of its own. */
const GUIDES_SELECTOR = "[data-sidebar-guidelines]";

/** A row that goes from its place in one look to its place in the other:
 *  at List-ness 1 it is moved by `x`, `y` from where the table lays it out.
 *  Its start for the frame that crossed is its own `translate`, which
 *  nothing else sets. */
interface Mover {
  element: HTMLElement;
  x: number;
  y: number;
  animation: Animation | null;
}

/** A name's cell whose visible end slides between the two looks' ends:
 *  where it stands in each, at the scrollport's width `port` the move
 *  started at; its clear tail and dissolve; whether the table cuts it, as
 *  its mask's end says now (the List wraps it and cuts nothing). `row` is
 *  its row's index in the episode's rows. */
interface Slide {
  cell: HTMLElement;
  list: NamePlace;
  table: NamePlace;
  port: number;
  tail: number;
  dissolve: number;
  tableCuts: boolean | null;
  row: number;
  animation: Animation | null;
}

/** A part of one look: the table's (`table`) or the List's (`list`). */
interface Fade {
  element: Element;
  pseudoElement?: "::before" | "::after";
  look: "table" | "list";
  /** Its own opacity when the move took it (a count under Connect): the
   *  share is of this. */
  own: number;
  animation: Animation | null;
}

interface Episode {
  toTable: boolean;
  listScroll: number;
  tableScroll: number;
  rows: HTMLElement[];
  movers: Mover[];
  fades: Fade[];
  slides: Slide[];
  /** How the List stands a row by its name's height. */
  listRows: ListRowModel | null;
  /** The shares the parts of each look had when the run began. */
  tableFrom: number;
  listFrom: number;
  segment: MoveSegment;
  /** How the run moves, read as it starts (УД11): the spring under the
   *  edge in hand and in Full, Minimal's move for a command's width. */
  motion: Exclude<SpringMotion, "instant">;
  /** The run's settling time from rest, which the fades take their shares
   *  of: the spring's, or Перемещение's for Minimal's move. */
  settleMs: number;
  /** An animation of nothing that lasts the run: its time is the run's,
   *  its end the run's end. */
  clock: Animation | null;
  /** An animation of nothing that ends when the table's parts are gone,
   *  going back to the List. */
  bareClock: Animation | null;
  /** Going to the table: lets the strips take their widths, held from the
   *  frame that crossed (`STRIP_TILES_FRAME`). */
  releaseStrips: (() => void) | null;
}

/** The frame after the crossing in which the strips take their tiles, going
 *  to the table (user's decision of 15.11.2026; SPEC_SIDEBAR_STRIP.md, ЛМ2):
 *  the crossing lays the table out and starts the move, the next frame makes
 *  the move's animations, and this one lays out the tiles. The strips stand
 *  transparent until the fade-in, halfway through the move, 220.5 ms on the
 *  spring and 100 ms on Minimal's move, far past it. */
export const STRIP_TILES_FRAME = 2;

/** Where a name's cell stands in one layout (`ReadLayout.names`): `height`
 *  is its box's, `textHeight` its text's, which its lines change. */
interface NamePlace {
  left: number;
  rightInset: number;
  width: number;
  height: number;
  textEnd: number;
  textHeight: number;
}

/** The places of one layout, and each row's body and count, top in the
 *  content and right edge on screen. */
interface ReadLayout {
  rows: HTMLElement[];
  layout: RowsLayout;
  boxes: Map<Element, { top: number; right: number }>;
  /** Each name's cell: its left edge from the scrollport's, its right
   *  edge's distance to the scrollport's (which a wider or narrower List
   *  keeps), its size, and where its text ends from its left edge. */
  names: Map<HTMLElement, NamePlace>;
  /** The scrollport's box width. */
  portWidth: number;
  /** Read in the List: how it stands a row by its name's height. */
  listRows: ListRowModel | null;
}

/** What the element's own style makes its opacity, read before the move
 *  animates it. */
function ownOpacity(element: Element): number {
  const opacity = parseFloat(getComputedStyle(element).opacity);
  return Number.isFinite(opacity) ? opacity : 1;
}

/** Keeps the list's scrollport `nav` in the look its width gives and moves
 *  its rows between the List and the table as the list crosses the compact
 *  threshold. Puts it in its look at once, before it is first painted.
 *  Returns the teardown. Where ResizeObserver is missing nothing is kept;
 *  where WAAPI is, for a command's width at Off or after a key, while the
 *  narrow table is the look below the threshold (sidebarRowsMorph.ts) and
 *  for a step larger than `LIST_MORPH_STEP_LIMIT_PX` the look changes at
 *  once. While the sidebar's
 *  width moves (`SIDEBAR_WIDTH_MOTION_ATTRIBUTE`: a collapse, an opening,
 *  leaving the row and coming back) the look is its open width's from the
 *  motion's first frame to its last, whatever width it passes, and nothing
 *  moves (user's decision of 01.11.2026). */
export function observeSidebarListMorph(nav: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const canMove = typeof nav.animate === "function";
  const threshold = sidebarCompactRowsBelowPx();
  const initial = sidebarContentWidth(nav);
  if (initial > 0) setSidebarLook(nav, sidebarLookAt(initial));
  // Where WAAPI cannot animate a pseudo-element, the rows' lines and the
  // List's marks change with the layout, and the marks are not drawn on
  // the table.
  const pseudo = typeof KeyframeEffect !== "undefined" && animatesPseudoElements(nav);
  // A name's end slides by a registered property (global.css,
  // `--sidebar-name-q`); without them it changes with the layout.
  const animatesProperties = typeof CSS !== "undefined" && typeof CSS.registerProperty === "function";
  let previous: number | null = null;
  let switchingFrame = 0;
  /** The look the width or the open width gives, at once: `land` ends a move
   *  under way first. The frame that changes it marks the scrollport. */
  const switchAtOnce = (look: SidebarLook, land: boolean) => {
    if (nav.getAttribute(SIDEBAR_LOOK_ATTRIBUTE) !== look || (land && episode)) {
      nav.setAttribute(LOOK_SWITCHING_ATTRIBUTE, "");
      cancelAnimationFrame(switchingFrame);
      switchingFrame = requestAnimationFrame(() => nav.removeAttribute(LOOK_SWITCHING_ATTRIBUTE));
    }
    if (land && episode) finish(episode, 0);
    nav.removeAttribute(BARE_ATTRIBUTE);
    setSidebarLook(nav, look);
  };
  let episode: Episode | null = null;
  /** What of the scrollport's box its content does not take (a scrollbar,
   *  padding), from the last layout: the open width's look counts it. */
  let gutter = initial > 0 ? Math.max(0, nav.getBoundingClientRect().width - initial) : 0;
  /** The sidebar's width moves: the look is held at its open width's. */
  let held = false;
  /** The scroll this module last set: its scroll event is not a person's. */
  let ownScroll: number | null = null;

  const setScroll = (value: number) => {
    nav.scrollTop = value;
    ownScroll = nav.scrollTop;
  };

  const readLayout = (): ReadLayout => {
    const port = nav.getBoundingClientRect();
    const origin = port.top + nav.clientTop - nav.scrollTop;
    const rows = Array.from(nav.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    const boxes: ReadLayout["boxes"] = new Map();
    const names: ReadLayout["names"] = new Map();
    const keepBox = (element: Element | null) => {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) boxes.set(element, { top: rect.top - origin, right: rect.right });
    };
    const places = rows.map((row) => {
      const box = row.getBoundingClientRect();
      // The text's first line: a name wraps in the List, and its first line
      // is the one that rides.
      const named = row.querySelector(ANCHOR_SELECTOR)?.getClientRects()[0] ?? box;
      keepBox(row.querySelector(BODY_SELECTOR));
      keepBox(row.querySelector(COUNT_SELECTOR));
      const cell = row.querySelector<HTMLElement>(NAME_CELL_SELECTOR);
      const text = cell?.querySelector(NAME_TEXT_SELECTOR)?.getBoundingClientRect();
      if (cell && text && text.width > 0) {
        const rect = cell.getBoundingClientRect();
        names.set(cell, { left: rect.left - port.left, rightInset: port.right - rect.right, width: rect.width, height: rect.height, textEnd: text.right - rect.left, textHeight: text.height });
      }
      return { top: box.top - origin, bottom: box.bottom - origin, anchor: named.top + named.height / 2 - origin };
    });
    const listRows = nav.getAttribute(SIDEBAR_LOOK_ATTRIBUTE) === "compact" ? readListRows(rows, places, boxes, names, origin) : null;
    return { rows, layout: { rows: places, maxScroll: nav.scrollHeight - nav.clientHeight }, boxes, names, portWidth: port.width, listRows };
  };

  /** How the List, laid out now, stands a row: from its row with the
   *  shortest name, one line where any row has one. */
  const readListRows = (rows: HTMLElement[], places: RowPlace[], boxes: ReadLayout["boxes"], names: ReadLayout["names"], origin: number): ListRowModel | null => {
    let shortest = -1;
    let line = Infinity;
    rows.forEach((row, index) => {
      const place = names.get(row.querySelector<HTMLElement>(NAME_CELL_SELECTOR) as HTMLElement);
      if (place && place.height < line) {
        line = place.height;
        shortest = index;
      }
    });
    const row = rows[shortest];
    const place = places[shortest];
    const cell = row?.querySelector(NAME_CELL_SELECTOR);
    const body = row?.querySelector(BODY_SELECTOR);
    const count = row?.querySelector(COUNT_SELECTOR);
    const countBox = count ? boxes.get(count) : undefined;
    if (!place || !cell || !body || !countBox) return null;
    return {
      line,
      pad: parseFloat(getComputedStyle(body).paddingTop) || 0,
      anchorInCell: place.anchor - (cell.getBoundingClientRect().top - origin),
      one: { height: place.bottom - place.top, anchor: place.anchor - place.top, count: countBox.top - place.top },
    };
  };

  /** The names on the rows the move shows whose visible end slides: those a
   *  look cuts at the width now, where the engine animates a registered
   *  property (`--sidebar-name-q`). The cell, laid out by the table, gets the
   *  List's end in its own terms, as an inset from the panel's width, which a
   *  drag going on keeps; and its mask's end in each look: the look's edge
   *  where it cuts the name, past the text's end and its dissolve where it
   *  does not. It gets the List's height too: it wraps as the List wraps
   *  it, and the List does not cut it. Going to the List, a name
   *  that fits now but that a narrower width would cut stays whole, with no
   *  animation: it lands whole. */
  const slidingNames = (shown: number[], list: ReadLayout, table: ReadLayout, toTable: boolean): Slide[] => {
    if (!animatesProperties) return [];
    const narrowest = sidebarRowsWidthPx(sidebarBesideMinWidthPx());
    const slides: Slide[] = [];
    shown.forEach((index, row) => {
      const cell = table.rows[index]?.querySelector<HTMLElement>(NAME_CELL_SELECTOR);
      const inList = cell ? list.names.get(cell) : undefined;
      const inTable = cell ? table.names.get(cell) : undefined;
      if (!cell || !inList || !inTable) return;
      const slide: Slide = {
        cell,
        list: inList,
        table: inTable,
        port: table.portWidth,
        tail: Number(cell.getAttribute("data-sidebar-title-protected-width")) || 0,
        dissolve: Number(cell.getAttribute("data-sidebar-title-fade-width")) || 0,
        tableCuts: null,
        row,
        animation: null,
      };
      if (!cutsAt(slide, table.portWidth)) {
        if (!toTable && cutsAt(slide, narrowest)) cell.setAttribute(NAME_WHOLE_ATTRIBUTE, "");
        return;
      }
      cell.style.setProperty(NAME_LIST_INSET_PROPERTY, `${sidebarPanelWidthPx(inList.rightInset + inTable.left)}px`);
      cell.style.setProperty(NAME_LIST_HEIGHT_PROPERTY, `${inList.height}px`);
      // The List wraps the name and ends a line anywhere up to its edge: its
      // end lies past that edge and the dissolve.
      cell.style.setProperty(NAME_EDGE_LIST_PROPERTY, `calc(var(--sidebar-name-list-w) + ${slide.tail + slide.dissolve}px)`);
      fitEnds(slide, table.portWidth);
      cell.setAttribute(NAME_SLIDE_ATTRIBUTE, "");
      slides.push(slide);
    });
    return slides;
  };

  /** Whether the table cuts the name with the scrollport `port` wide: by
   *  the rule textClip.ts keeps the cell's dissolve by, the table's cell as
   *  wide as its name column. The List wraps it and cuts nothing. */
  const cutsAt = (slide: Slide, port: number) => {
    const gain = sidebarNameColumnPx(port) - sidebarNameColumnPx(slide.port);
    return slide.table.textEnd > slide.table.width + gain - slide.tail + 0.5;
  };
  /** Gives the mask its end in the table for the scrollport `port` wide:
   *  the table's edge where it cuts the name, past the text's end and its
   *  dissolve where it does not. Written only when that changes, in the
   *  frames of a drag that goes on through the move. */
  const fitEnds = (slide: Slide, port: number) => {
    const table = cutsAt(slide, port);
    if (table === slide.tableCuts) return;
    slide.tableCuts = table;
    const past = `${slide.table.textEnd + slide.tail + slide.dissolve}px`;
    slide.cell.style.setProperty(NAME_EDGE_TABLE_PROPERTY, table ? "var(--sidebar-name-table-w)" : `max(var(--sidebar-name-table-w), ${past})`);
  };

  /** The parts of the rows the move shows, with their ends. */
  const buildParts = (shown: number[], offsets: number[], list: ReadLayout, table: ReadLayout, toTable: boolean): { movers: Mover[]; fades: Fade[]; slides: Slide[] } => {
    const movers: Mover[] = [];
    const fades: Fade[] = [];
    const slides = slidingNames(shown, list, table, toTable);
    const fade = (element: Element | null, look: Fade["look"], pseudoElement?: Fade["pseudoElement"], own = 1) => {
      if (element) fades.push({ element, pseudoElement, look, own, animation: null });
    };
    const placed: { leader: HTMLElement | null; mark: HTMLElement; top: number; right: number; font: string }[] = [];
    fade(nav.querySelector(GUIDES_SELECTOR), "table");
    for (const index of shown) {
      const row = table.rows[index]!;
      const offset = offsets[index]!;
      if (Math.abs(offset) > 0.01) movers.push({ element: row, x: 0, y: offset, animation: null });
      if (pseudo) fade(row, "table", "::after");
      fade(row.querySelector(RAIL_SELECTOR), "table");
      fade(row.querySelector("[data-sidebar-editable-row-guideline]"), "table");
      // The table's count and its plates.
      const count = row.querySelector(COUNT_SELECTOR);
      for (const element of [count, ...row.querySelectorAll(LINK_SELECTOR)]) if (element) fade(element, "table", undefined, ownOpacity(element));
      if (!pseudo) continue;
      // The List's leader and its count, the count at its place in
      // the List, in its own type: a part of its own, not the table's count
      // moved.
      const body = row.querySelector<HTMLElement>(BODY_SELECTOR);
      const leader = body?.querySelector<HTMLElement>(LIST_LEADER_SELECTOR) ?? null;
      const mark = body?.querySelector<HTMLElement>(LIST_COUNT_MARK_SELECTOR) ?? null;
      fade(leader, "list");
      const anchorList = list.layout.rows[index]!.anchor;
      const anchorTable = table.layout.rows[index]!.anchor;
      const countList = count ? list.boxes.get(count) : undefined;
      const bodyList = body ? list.boxes.get(body) : undefined;
      const bodyTable = body ? table.boxes.get(body) : undefined;
      if (!mark || !count || !countList || !bodyList || !bodyTable) continue;
      placed.push({
        leader,
        mark,
        top: (countList.top - anchorList) - (bodyTable.top - anchorTable),
        right: bodyList.right - countList.right,
        font: getComputedStyle(count).fontFamily,
      });
      fade(mark, "list");
    }
    for (const { leader, mark, top, right, font } of placed) {
      leader?.setAttribute(LIST_COUNT_ATTRIBUTE, "");
      leader?.style.setProperty(LIST_COUNT_TOP_PROPERTY, `${top}px`);
      mark.setAttribute(LIST_COUNT_ATTRIBUTE, "");
      mark.style.setProperty(LIST_COUNT_TOP_PROPERTY, `${top}px`);
      mark.style.setProperty(LIST_COUNT_RIGHT_PROPERTY, `${right}px`);
      mark.style.setProperty(LIST_COUNT_FONT_PROPERTY, font);
    }
    return { movers, fades, slides };
  };

  const animations = (current: Episode) => [
    ...(current.clock ? [current.clock] : []),
    ...(current.bareClock ? [current.bareClock] : []),
    ...current.movers.flatMap((mover) => (mover.animation ? [mover.animation] : [])),
    ...current.fades.flatMap((fade) => (fade.animation ? [fade.animation] : [])),
    ...current.slides.flatMap((slide) => (slide.animation ? [slide.animation] : [])),
  ];

  const cancel = (current: Episode) => {
    for (const animation of animations(current)) animation.cancel();
    for (const mover of current.movers) mover.animation = null;
    for (const fade of current.fades) fade.animation = null;
    for (const slide of current.slides) slide.animation = null;
    current.clock = null;
    current.bareClock = null;
  };

  /** Writes each moving part where it starts, for the frame that crossed:
   *  its animation is made in the next frame. A row's start is its own
   *  `translate`: in Chromium it costs that frame less style work than the
   *  row's `transform` (SPEC_SIDEBAR_STRIP.md, ЛМ5). */
  const place = (current: Episode) => {
    const q = current.segment.q0;
    for (const mover of current.movers) mover.element.style.translate = `${mover.x * q}px ${mover.y * q}px`;
    for (const slide of current.slides) slide.cell.style.setProperty(NAME_Q_PROPERTY, String(q));
  };
  const unplace = (current: Episode) => {
    for (const mover of current.movers) mover.element.style.removeProperty("translate");
    for (const slide of current.slides) slide.cell.style.removeProperty(NAME_Q_PROPERTY);
  };

  /** The move ends where it was going; `scrolled` is how far a person
   *  scrolled the table meanwhile. The animations go first, so the restyle
   *  that follows reads none of them; the List's marks go before the List
   *  is laid out, on the table they stand by the table's measures. */
  /** Lets the strips held for `current` take their widths, once. */
  const releaseStrips = (current: Episode) => {
    const release = current.releaseStrips;
    current.releaseStrips = null;
    release?.();
  };

  const finish = (current: Episode, scrolled: number) => {
    if (episode !== current) return;
    episode = null;
    // The strips show from here on: they take their tiles before this
    // frame paints.
    releaseStrips(current);
    cancel(current);
    unplace(current);
    nav.removeAttribute(FADE_ATTRIBUTE);
    nav.removeAttribute(MARKS_ATTRIBUTE);
    for (const row of current.rows) {
      row.querySelector(NAME_CELL_SELECTOR)?.removeAttribute(NAME_WHOLE_ATTRIBUTE);
      const body = row.querySelector(BODY_SELECTOR);
      for (const mark of [body?.querySelector<HTMLElement>(LIST_LEADER_SELECTOR), body?.querySelector<HTMLElement>(LIST_COUNT_MARK_SELECTOR)]) {
        if (!mark?.hasAttribute(LIST_COUNT_ATTRIBUTE)) continue;
        mark.removeAttribute(LIST_COUNT_ATTRIBUTE);
        for (const property of [LIST_COUNT_TOP_PROPERTY, LIST_COUNT_RIGHT_PROPERTY, LIST_COUNT_FONT_PROPERTY]) mark.style.removeProperty(property);
      }
    }
    for (const { cell } of current.slides) {
      cell.removeAttribute(NAME_SLIDE_ATTRIBUTE);
      for (const property of [NAME_LIST_INSET_PROPERTY, NAME_LIST_HEIGHT_PROPERTY, NAME_EDGE_TABLE_PROPERTY, NAME_EDGE_LIST_PROPERTY]) cell.style.removeProperty(property);
    }
    nav.removeAttribute(BARE_ATTRIBUTE);
    if (current.toTable) return;
    setSidebarLook(nav, "compact");
    setScroll(current.listScroll + scrolled);
  };

  /** On whole device pixels, so a part's text is sharp and at its last place
   *  from the frame the spring's tail comes within one, not from the landing. */
  const onPixels = (value: number) => {
    const scale = window.devicePixelRatio || 1;
    return Math.round(value * scale) / scale;
  };
  const playMover = (mover: Mover, curve: { offset: number; q: number }[], duration: number) => mover.element.animate(
    curve.map((frame) => ({ offset: frame.offset, transform: `translate(${onPixels(mover.x * frame.q)}px, ${onPixels(mover.y * frame.q)}px)` })),
    { duration, fill: "both" },
  );

  /** Makes the run's moves, started at `time`, or now, in place of the
   *  parts written where they start. */
  const makeMoves = (current: Episode, time: number | null) => {
    const curve = moveCurve(current.segment);
    for (const mover of current.movers) {
      mover.animation = playMover(mover, curve, current.segment.spring.durationMs);
      if (time !== null) mover.animation.startTime = time;
    }
    for (const slide of current.slides) {
      slide.animation = slide.cell.animate(
        curve.map((frame) => ({ offset: frame.offset, [NAME_Q_PROPERTY]: frame.q })),
        { duration: current.segment.spring.durationMs, fill: "both" },
      );
      if (time !== null) slide.animation.startTime = time;
    }
    unplace(current);
  };

  /** Makes the run's fades, started at `time`, or now. Every effect is
   *  made before any of them plays: an effect on a pseudo-element made while
   *  the page's style is not settled recalculates it, and each animation
   *  that plays unsettles it, so making and playing them in turn cost a
   *  recalculation for every fade on a pseudo-element (Chromium's trace,
   *  15.11.2026). */
  const makeFades = (current: Episode, time: number | null) => {
    const keyframes = current.fades.map((fade) => {
      const tableLook = fade.look === "table";
      const track = fadeTrack(tableLook === current.toTable ? "in" : "out", tableLook ? current.tableFrom : current.listFrom, current.settleMs);
      const options: KeyframeEffectOptions = { duration: track.durationMs, easing: "linear", fill: "both", pseudoElement: fade.pseudoElement };
      return { frames: track.frames.map((frame) => ({ offset: frame.offset, opacity: frame.share * fade.own })), options };
    });
    if (typeof KeyframeEffect === "undefined" || typeof Animation === "undefined") {
      current.fades.forEach((fade, index) => {
        fade.animation = fade.element.animate(keyframes[index]!.frames, keyframes[index]!.options);
        if (time !== null) fade.animation.startTime = time;
      });
      return;
    }
    const effects = current.fades.map((fade, index) => new KeyframeEffect(fade.element, keyframes[index]!.frames, keyframes[index]!.options));
    current.fades.forEach((fade, index) => {
      const animation = new Animation(effects[index], document.timeline);
      if (time !== null) animation.startTime = time;
      else animation.play();
      fade.animation = animation;
    });
  };

  /** A drag going on through the move changes the width the List wraps at.
   *  The name's cell takes its new lines in the frame they change, as it does
   *  at rest; the List's count and leader stand on the last of them, and the
   *  row and those below land where the List stands them now, so the landing
   *  moves nothing. Reads layout the frame has already done, on the names
   *  that slide. */
  const followLines = (current: Episode) => {
    if (!current.listRows) return;
    const moved = new Set<Mover>();
    const moveRow = (row: HTMLElement, by: number) => {
      if (Math.abs(by) < 0.01) return;
      let mover = current.movers.find((candidate) => candidate.element === row);
      if (!mover) {
        mover = { element: row, x: 0, y: 0, animation: null };
        current.movers.push(mover);
      }
      mover.y += by;
      moved.add(mover);
    };
    for (const slide of current.slides) {
      const height = slide.cell.querySelector(NAME_TEXT_SELECTOR)?.getBoundingClientRect().height;
      if (height === undefined) continue;
      const lines = height - slide.list.textHeight;
      if (Math.abs(lines) < 1) continue;
      const was = listRowAt(current.listRows, slide.list.height);
      slide.list.textHeight = height;
      slide.list.height += lines;
      const now = listRowAt(current.listRows, slide.list.height);
      slide.cell.style.setProperty(NAME_LIST_HEIGHT_PROPERTY, `${slide.list.height}px`);
      const row = current.rows[slide.row];
      if (!row) continue;
      const body = row.querySelector(BODY_SELECTOR);
      for (const mark of [body?.querySelector<HTMLElement>(LIST_LEADER_SELECTOR), body?.querySelector<HTMLElement>(LIST_COUNT_MARK_SELECTOR)]) {
        const top = parseFloat(mark?.style.getPropertyValue(LIST_COUNT_TOP_PROPERTY) ?? "");
        if (mark && Number.isFinite(top)) mark.style.setProperty(LIST_COUNT_TOP_PROPERTY, `${top + (now.count - now.anchor) - (was.count - was.anchor)}px`);
      }
      moveRow(row, now.anchor - was.anchor);
      for (const below of current.rows.slice(slide.row + 1)) moveRow(below, now.height - was.height);
    }
    if (moved.size === 0 || current.clock?.startTime == null) return;
    const curve = moveCurve(current.segment);
    for (const mover of moved) {
      mover.animation?.cancel();
      mover.animation = playMover(mover, curve, current.segment.spring.durationMs);
      mover.animation.startTime = current.clock.startTime;
    }
  };

  /** `fromRest`: the frame that crossed the threshold lays the list out anew
   *  and may take long; an animation started on it would show its first
   *  frame already under way, and making it there would add its style pass
   *  to that frame. The frame writes each moving part where it starts; the
   *  next one makes the moves and the fades and starts them. A turn goes on
   *  at once, at the speed it had. */
  const run = (current: Episode, fromRest: boolean) => {
    const { spring } = current.segment;
    nav.setAttribute(FADE_ATTRIBUTE, current.toTable ? "table" : "list");
    const host = nav.querySelector(GUIDES_SELECTOR) ?? nav;
    const clock = host.animate([], { duration: Math.max(spring.durationMs, current.settleMs) });
    current.clock = clock;
    // Going back to the List the table's parts leave the layout once they
    // are gone; going to the table they are in it from the first frame.
    if (current.toTable) {
      nav.removeAttribute(BARE_ATTRIBUTE);
    } else if (!nav.hasAttribute(BARE_ATTRIBUTE)) {
      const bareClock = host.animate([], { duration: current.settleMs * (LIST_MORPH_FADE_OUT_MS / LIST_MORPH_SETTLE_MS) });
      current.bareClock = bareClock;
      void bareClock.finished.then(() => {
        if (episode === current && current.bareClock === bareClock) nav.setAttribute(BARE_ATTRIBUTE, "");
      }, () => undefined);
    }
    void clock.finished.then(() => finish(current, 0), () => undefined);
    if (!fromRest) {
      makeMoves(current, null);
      makeFades(current, null);
      return;
    }
    place(current);
    const clocks = animations(current);
    for (const animation of clocks) animation.pause();
    requestAnimationFrame((time) => {
      // A turn before this frame cancelled these; a start time would play
      // them again.
      if (episode !== current || current.clock !== clock) return;
      for (const animation of clocks) animation.startTime = time;
      makeMoves(current, time);
      makeFades(current, time);
    });
  };

  /** A move from the look on screen across the threshold, as `motion`. */
  const start = (toTable: boolean, motion: Exclude<SpringMotion, "instant">) => {
    const scroll = nav.scrollTop;
    const height = nav.clientHeight;
    // Each scroll is the one the engine takes: it sets a scroll on its own
    // pixels, and the rows land on what it took.
    let list: ReadLayout;
    let table: ReadLayout;
    let listScroll = scroll;
    let heldStrips: (() => void) | null = null;
    if (toTable) {
      // The frame that crossed laid the List out at the new width before
      // this observer heard of it: its places are read where they stand.
      // Then the scrollport takes the table's look, which this frame paints,
      // its strips transparent: their tiles wait (`STRIP_TILES_FRAME`).
      list = readLayout();
      heldStrips = holdStripWidths();
      // The move's own marks come with the look, which the read of the
      // table's places settles: one recalculation of the list's style, not
      // a second for them after the read. They change no place.
      setSidebarLook(nav, "table");
      nav.setAttribute(FADE_ATTRIBUTE, "table");
      nav.toggleAttribute(MARKS_ATTRIBUTE, pseudo);
      table = readLayout();
      setScroll(anchoredScroll(list.layout, table.layout, scroll));
    } else {
      // The look keeps the table: its places are read where it stands.
      table = readLayout();
      // The List laid out for the read alone, with the scroll it takes.
      setSidebarLook(nav, "compact");
      list = readLayout();
      nav.scrollTop = anchoredScroll(table.layout, list.layout, scroll);
      listScroll = nav.scrollTop;
      setSidebarLook(nav, "table");
      setScroll(scroll);
    }
    const tableScroll = nav.scrollTop;
    const offsets = rowOffsets(list.layout, table.layout, listScroll, tableScroll);
    const shown = rowsOnTheWay(table.layout, offsets, tableScroll, height);
    const { movers, fades, slides } = buildParts(shown, offsets, list, table, toTable);
    nav.toggleAttribute(MARKS_ATTRIBUTE, pseudo);
    episode = {
      toTable,
      listScroll,
      tableScroll,
      rows: shown.map((index) => table.rows[index]!),
      movers,
      fades,
      slides,
      listRows: list.listRows,
      tableFrom: toTable ? 0 : 1,
      listFrom: toTable ? 1 : 0,
      segment: toTable ? segmentToward(1, 0, 0, motion) : segmentToward(0, 1, 0, motion),
      motion,
      settleMs: motion === "move" ? MOTION_SPRING_MOVE_MS : LIST_MORPH_SETTLE_MS,
      clock: null,
      bareClock: null,
      releaseStrips: heldStrips,
    };
    run(episode, true);
    if (heldStrips) {
      const current = episode;
      const wait = (frames: number) => requestAnimationFrame(() => {
        if (episode !== current) return;
        if (frames > 1) wait(frames - 1);
        else releaseStrips(current);
      });
      wait(STRIP_TILES_FRAME);
    }
  };

  /** Back across the threshold mid-move: from where it is, at the speed it
   *  had; the fades start again from where they are. The table's look stays
   *  through the move either way. */
  const turn = (current: Episode) => {
    const elapsed = Number(current.clock?.currentTime ?? 0);
    const { q, speed } = segmentAt(current.segment, elapsed);
    current.tableFrom = fadeShare(current.toTable ? "in" : "out", elapsed, current.tableFrom, current.settleMs);
    current.listFrom = fadeShare(current.toTable ? "out" : "in", elapsed, current.listFrom, current.settleMs);
    cancel(current);
    current.toTable = !current.toTable;
    current.segment = segmentToward(q, current.toTable ? 0 : 1, speed, current.motion);
    run(current, false);
  };

  const onWidth = (width: number) => {
    // The width's motion passes widths that are not the sidebar's.
    if (held) return;
    // WAAPI, which no CSS rule of the level reaches (Р2): the spring under
    // the edge in hand on every level (Р1); a command's width by its level
    // and at once after a key (С3, РД4, Р4).
    const motion = sidebarMorphMotion();
    const step = widthStep({
      active: canMove && getSidebarStyle() === "list" && motion !== "instant",
      threshold,
      width,
      previous,
      movingToTable: episode?.toTable ?? null,
    });
    previous = width > 0 ? width : null;
    switch (step) {
      case "idle":
      case "instant":
        if (width > 0) switchAtOnce(sidebarLookAt(width), true);
        else {
          if (episode) finish(episode, 0);
          nav.removeAttribute(BARE_ATTRIBUTE);
        }
        return;
      case "rest":
        switchAtOnce(sidebarLookAt(width), false);
        return;
      case "start":
        // A start is only ever active: the drag or the level moves it.
        if (motion !== "instant") start(width >= threshold, motion);
        return;
      case "turn":
        for (const slide of episode!.slides) fitEnds(slide, width + gutter);
        followLines(episode!);
        turn(episode!);
        return;
      case "go-on":
        // The ends follow the width; a name's cut can come or go, its lines
        // in the List change.
        if (!episode) return;
        for (const slide of episode.slides) fitEnds(slide, width + gutter);
        followLines(episode);
        return;
    }
  };

  /** The width's motion begins (the attribute names the open width) or
   *  ends. From its first frame the look is the open width's, a move under
   *  way landed where it was going; after its last the look follows the
   *  width at once, with no move: the width is the open one again, or the
   *  sidebar is collapsed. */
  const onMotion = () => {
    const open = Number(nav.getAttribute(SIDEBAR_WIDTH_MOTION_ATTRIBUTE) ?? NaN);
    if (open > 0) {
      held = true;
      previous = null;
      switchAtOnce(sidebarLookOfPanel(open, gutter), true);
      return;
    }
    if (!held) return;
    held = false;
    onWidth(sidebarContentWidth(nav));
  };
  const motionWatch = new MutationObserver(onMotion);
  motionWatch.observe(nav, { attributes: true, attributeFilter: [SIDEBAR_WIDTH_MOTION_ATTRIBUTE] });
  onMotion();

  /** A person scrolling the list mid-move: it ends where it was going. */
  const onScroll = () => {
    if (!episode) return;
    if (ownScroll !== null && Math.abs(nav.scrollTop - ownScroll) < 1) return;
    finish(episode, nav.scrollTop - episode.tableScroll);
  };

  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    const box = entry.borderBoxSize?.[0]?.inlineSize;
    if (box !== undefined && width > 0) gutter = Math.max(0, box - width);
    onWidth(width);
  });
  observer.observe(nav);
  nav.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    observer.disconnect();
    motionWatch.disconnect();
    nav.removeEventListener("scroll", onScroll);
    if (episode) finish(episode, 0);
    nav.removeAttribute(BARE_ATTRIBUTE);
    cancelAnimationFrame(switchingFrame);
    nav.removeAttribute(LOOK_SWITCHING_ATTRIBUTE);
  };
}
