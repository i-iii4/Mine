// TRIAL (SPEC_CARD_PEEK.md; user's requests of 23.10.2026): the open card's
// window over the right part, the rules its motion keeps. The component
// (CardPeek.tsx) measures and writes; these functions decide: where the window
// and the card's picture stand at a point of the motion, how the spring
// moves, when the content shows, how an opening and a closing go.
//
// The window grows out of a card of another proportion, and a corner, a line
// and a shadow do not survive a non-uniform scale (О12). Its frame is drawn
// in pieces while it moves: two bands of fill, four lines and four corners,
// each moved and scaled only along the axis where scaling changes nothing (a
// band of flat fill, a line along its own length), the corners only moved.
// The content inside is clipped by a box scaled to the frame and scaled back
// by the inverse, so no letter is ever stretched. The card's picture rides a
// clip of its own with the picture scaled uniformly inside it: the visible
// part goes from the card's crop to the whole picture with no switch (О10, п. 3).

import { useSyncExternalStore } from "react";
import { SPRING_SETTLE, springSettleMs } from "./channelIcon";
import {
  DETAIL_CONTENT_MAX_WIDTH_PX,
  DETAIL_RAIL_LINE_PX,
  DETAIL_RAIL_WIDTH_PX,
  detailLayout,
  type DetailLayoutMode,
} from "./detailLayout";

/** `M`: the window's distance from each edge of the right part (О3). */
export const CARD_PEEK_MARGIN_PX = 40;

/** The window's corner at its place, and where its growth ends: 4 px, the
 *  user's own value for this window (decision of 23.10.2026), set here
 *  alone, not a token of the design system. */
export const CARD_PEEK_RADIUS_PX = 4;

/** The window's widest: the open card's widest, its reading column and its
 *  framed panel, each with the card's inset on either side, the line
 *  between them and the window's line on both sides (О3; user's decisions
 *  of 24.10.2026). Narrower only when the right part is; the window stands
 *  centred in it. */
export const CARD_PEEK_MAX_WIDTH = `calc(${DETAIL_CONTENT_MAX_WIDTH_PX + DETAIL_RAIL_WIDTH_PX + DETAIL_RAIL_LINE_PX}px + 4 * var(--card-content-pad) + 2px)`;

/** The window's widest with the panel under the content (О3; user's
 *  request of 24.10.2026): the drawn content `contentWidth` (Р1) with the
 *  card's inset on either side and the window's line on both sides, so the
 *  window is no wider than its content. */
export function cardPeekStackedMaxWidth(contentWidth: number): string {
  return `calc(${contentWidth + 2}px + 2 * var(--card-content-pad))`;
}

/** Where the open card's panel stands in the window (О8): beside the content
 *  or under it, by the full page's rule (`detailLayout`) for the inside of
 *  the widest window the right part holds, `available` (the right part less
 *  `M` on either side), its line off both sides. The window's width now does
 *  not decide: a window narrowed to its content would never find room for
 *  the panel again. */
export function peekWindowLayout(available: number, contentWidth: number, padPx: number): DetailLayoutMode {
  return detailLayout(available - 2, padPx, contentWidth).mode;
}

/** The window's header, always shown above the card (О9): 40 px, the
 *  user's own value for this window (decision of 24.10.2026), its line
 *  included. */
export const CARD_PEEK_PLATE_HEIGHT_PX = 40;

/** How small the window is when it comes out of the right part's centre and
 *  goes back there: the dialogs' `zoom-out-95` (О10, О11). */
export const CARD_PEEK_CENTER_SCALE = 0.95;

/** How far the window steps back while the pointer rests on the scrim round
 *  it, as a card about to be swept down: a sixth of the way to its leaving
 *  scale (`CARD_PEEK_CENTER_SCALE`, the dialogs' `zoom-out-95`), about
 *  99.2 % (user's decision of 24.10.2026: a third of the half first tried). */
export const CARD_PEEK_NUDGE_SCALE = 1 - (1 - CARD_PEEK_CENTER_SCALE) / 6;

/** How far down the window moves then, a sixth of `M` (user's decision of
 *  24.10.2026: a third of the half first tried); the field over it, where
 *  the hint stands, grows by as much. */
export const CARD_PEEK_NUDGE_OFFSET_PX = CARD_PEEK_MARGIN_PX / 6;

/** The window stepped back `share` of the way (0 at its place, 1 nudged),
 *  as a transform about its centre. */
export function peekNudgeTransform(share: number): string {
  if (Math.abs(share) < 1e-4) return "";
  const scale = 1 - (1 - CARD_PEEK_NUDGE_SCALE) * share;
  return `translateY(${Math.round(CARD_PEEK_NUDGE_OFFSET_PX * share * 1e3) / 1e3}px) scale(${Math.round(scale * 1e6) / 1e6})`;
}

/** What undoes `peekNudgeTransform(share)` about the same centre: a piece
 *  inside the stepped window that stays where the card is. */
export function peekNudgeUndoTransform(share: number): string {
  if (Math.abs(share) < 1e-4) return "";
  const scale = 1 - (1 - CARD_PEEK_NUDGE_SCALE) * share;
  return `scale(${Math.round(1e6 / scale) / 1e6}) translateY(${-Math.round(CARD_PEEK_NUDGE_OFFSET_PX * share * 1e3) / 1e3}px)`;
}

/** The window's spring (SPEC_CARD_PEEK.md, «Величины»): critically damped,
 *  response 0.25 s (user's decision of 24.10.2026: faster than the compact
 *  stack's 0.3 s, `SPRING_RESPONSE_S` in channelIcon.ts, which keeps it). */
export const CARD_PEEK_SPRING_RESPONSE_S = 0.25;

/** How long the window's spring takes from rest, by the stack's rule:
 *  until it is within 0.1% of its target. */
export const CARD_PEEK_SPRING_MS = springSettleMs(CARD_PEEK_SPRING_RESPONSE_S);

/** A closing's first third, by time: the content fades out over it. */
export const CARD_PEEK_CONTENT_FADE_MS = CARD_PEEK_SPRING_MS / 3;

/** When the content starts showing in an opening: halfway (user's decision
 *  of 24.10.2026); it shows over the second half. */
export const CARD_PEEK_CONTENT_IN_FROM_MS = CARD_PEEK_SPRING_MS / 2;

/** How long after the input that opened it an opening still counts as that
 *  input's: a card read by its slug (the graph, a search result) opens a
 *  moment after the click. */
export const CARD_PEEK_INPUT_WINDOW_MS = 1000;

/** One frame of the display, 60 Hz. */
const DISPLAY_FRAME_MS = 1000 / 60;

/** The longest step the spring takes from one frame to the next: one frame,
 *  with room for a frame's own jitter. A frame held up longer (a busy main
 *  thread) slows the motion for that frame instead of jumping it ahead
 *  (SPEC_CARD_PEEK.md, О12). */
export const CARD_PEEK_FRAME_STEP_MS = DISPLAY_FRAME_MS * 1.05;

/** How long the window waits, before it starts, for the card it shows to be
 *  whole: its module, its file, its editor, its picture decoded. Past it the
 *  window starts with what it has, and what comes later lands once it rests. */
export const CARD_PEEK_PREPARE_MAX_MS = 100;

/** The smallest side a moving box is given, so its inverse stays finite. */
const MIN_SIDE_PX = 0.01;

/** The window's line, 1px (`border`). */
const FRAME_LINE_PX = 1;

// ─── Geometry ───────────────────────────────────────────────────────────

/** A box in one coordinate space, px. */
export interface PeekRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The box `t` of the way from `a` to `b`, each side alike. */
export function lerpPeekRect(a: PeekRect, b: PeekRect, t: number): PeekRect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  };
}

/** `rect` scaled by `scale` about its centre. */
export function centerPeekRect(rect: PeekRect, scale: number): PeekRect {
  const width = rect.width * scale;
  const height = rect.height * scale;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

/** A box `width` wide centred on `rect`, as tall: the window narrower or
 *  wider about its centre, where the right part centres it. */
export function centredPeekRect(rect: PeekRect, width: number): PeekRect {
  return { x: rect.x + (rect.width - width) / 2, y: rect.y, width, height: rect.height };
}

/** The part of `a` inside `b`. Nothing in common gives an empty box at the
 *  point of `b` nearest to `a`, so a picture scrolled away grows out of the
 *  window's edge instead of jumping. */
export function intersectPeekRect(a: PeekRect, b: PeekRect): PeekRect {
  const left = Math.min(Math.max(a.x, b.x), b.x + b.width);
  const top = Math.min(Math.max(a.y, b.y), b.y + b.height);
  const right = Math.max(Math.min(a.x + a.width, b.x + b.width), left);
  const bottom = Math.max(Math.min(a.y + a.height, b.y + b.height), top);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Whether two boxes share some area. */
export function peekRectsOverlap(a: PeekRect, b: PeekRect): boolean {
  const common = intersectPeekRect(a, b);
  return common.width > 0 && common.height > 0;
}

/** `rect` moved by `-origin`: from the viewport into the space of a box
 *  whose top left corner stands at `origin`. */
export function relativePeekRect(rect: PeekRect, origin: { x: number; y: number }): PeekRect {
  return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height };
}

/** Where a picture `naturalWidth × naturalHeight` lies when it covers `box`
 *  centred, as `object-fit: cover` draws it. */
export function coverPeekRect(box: PeekRect, naturalWidth: number, naturalHeight: number): PeekRect {
  if (naturalWidth <= 0 || naturalHeight <= 0 || box.width <= 0 || box.height <= 0) return box;
  const scale = Math.max(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

function side(value: number): number {
  return Math.max(MIN_SIDE_PX, value);
}

/** Six decimals: a scale of a box a thousand pixels wide stays within a
 *  thousandth of a pixel. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The transform that puts an element laid out as `laid` where `shown` is,
 *  both in the same space, its origin at its top left (`transform-origin:
 *  0 0`). */
export function peekBoxTransform(laid: PeekRect, shown: PeekRect): string {
  const scaleX = side(shown.width) / side(laid.width);
  const scaleY = side(shown.height) / side(laid.height);
  return `translate(${round(shown.x - laid.x)}px, ${round(shown.y - laid.y)}px) scale(${round(scaleX)}, ${round(scaleY)})`;
}

// ─── The frame in pieces ────────────────────────────────────────────────

/** The pieces the window's frame is drawn in while it moves. */
export const PEEK_FRAME_PIECES = [
  "shadow",
  "bandAcross",
  "bandDown",
  "lineTop",
  "lineBottom",
  "lineLeft",
  "lineRight",
  "cornerTopLeft",
  "cornerTopRight",
  "cornerBottomLeft",
  "cornerBottomRight",
] as const;
export type PeekFramePiece = (typeof PEEK_FRAME_PIECES)[number];

/** The four corners, in the order of `PEEK_FRAME_PIECES`. */
export const PEEK_FRAME_CORNERS = [
  "cornerTopLeft",
  "cornerTopRight",
  "cornerBottomLeft",
  "cornerBottomRight",
] as const;
export type PeekFrameCorner = (typeof PEEK_FRAME_CORNERS)[number];

/** How a frame is cut: `round`, the larger of the two corners (the card's
 *  and the window's), past which the edges are straight; `corner`, the side
 *  of a corner piece, a little more than `round`, so each corner overlaps
 *  the bands and lines beside it and no seam opens where they meet. */
export interface PeekFrameCut {
  round: number;
  corner: number;
}

/** The overlap of a corner piece with the straight edges beside it. */
const CORNER_OVERLAP_PX = 2;

/** The cut for a card corner `cardRadius` and a window corner `windowRadius`. */
export function peekFrameCut(cardRadius: number, windowRadius: number): PeekFrameCut {
  const round = Math.max(cardRadius, windowRadius, 0);
  return { round, corner: Math.ceil(round) + CORNER_OVERLAP_PX };
}

/** Each piece's box in a frame `width × height` whose top left is at 0, 0.
 *  The fill is two bands that never reach a corner's curve; the lines run
 *  between the corners; the corners are fixed squares. */
export function peekFramePieceBoxes(width: number, height: number, cut: PeekFrameCut): Record<PeekFramePiece, PeekRect> {
  const r = cut.round;
  const k = cut.corner;
  const across = Math.max(0, width - 2 * r);
  const down = Math.max(0, height - 2 * r);
  return {
    shadow: { x: 0, y: 0, width, height },
    bandAcross: { x: 0, y: r, width, height: down },
    bandDown: { x: r, y: 0, width: across, height },
    lineTop: { x: r, y: 0, width: across, height: FRAME_LINE_PX },
    lineBottom: { x: r, y: height - FRAME_LINE_PX, width: across, height: FRAME_LINE_PX },
    lineLeft: { x: 0, y: r, width: FRAME_LINE_PX, height: down },
    lineRight: { x: width - FRAME_LINE_PX, y: r, width: FRAME_LINE_PX, height: down },
    cornerTopLeft: { x: 0, y: 0, width: k, height: k },
    cornerTopRight: { x: width - k, y: 0, width: k, height: k },
    cornerBottomLeft: { x: 0, y: height - k, width: k, height: k },
    cornerBottomRight: { x: width - k, y: height - k, width: k, height: k },
  };
}

/** The transform of every piece of a frame laid out at its place, `laid`
 *  (`width × height` at 0, 0), shown as `shown`, a box in the same space:
 *  bands and lines scale only along themselves, corners only move. */
export function peekFrameTransforms(
  laid: { width: number; height: number },
  shown: PeekRect,
  cut: PeekFrameCut,
): Record<PeekFramePiece, string> {
  const from = peekFramePieceBoxes(laid.width, laid.height, cut);
  const to = peekFramePieceBoxes(shown.width, shown.height, cut);
  // Filled for every piece by the loop below before it is returned.
  const result = {} as Record<PeekFramePiece, string>;
  for (const piece of PEEK_FRAME_PIECES) {
    const box = to[piece];
    result[piece] = peekBoxTransform(from[piece], { ...box, x: box.x + shown.x, y: box.y + shown.y });
  }
  return result;
}

/** The window's surface, laid out at its place (`laid`, with its 1px line
 *  inside the box), shown as `shown`: the surface scales to the frame and
 *  clips the content; the content inside is scaled back by the inverse, so
 *  it is never stretched, and rides with the frame's centre. */
export function peekSurfaceTransforms(
  laid: { width: number; height: number },
  shown: PeekRect,
): { surface: string; content: string } {
  const scaleX = side(shown.width) / side(laid.width);
  const scaleY = side(shown.height) / side(laid.height);
  // The content box starts inside the 1px line; its offset in the surface's
  // own space keeps it centred on the shown frame, unscaled.
  const offsetX = ((shown.width - laid.width) / 2 + FRAME_LINE_PX) / scaleX - FRAME_LINE_PX;
  const offsetY = ((shown.height - laid.height) / 2 + FRAME_LINE_PX) / scaleY - FRAME_LINE_PX;
  return {
    surface: peekBoxTransform({ x: 0, y: 0, ...laid }, shown),
    content: `translate(${round(offsetX)}px, ${round(offsetY)}px) scale(${round(1 / scaleX)}, ${round(1 / scaleY)})`,
  };
}

/** The card's picture laid out as `laid` (clip and picture alike), shown
 *  through `clip` with the whole picture at `image`, all in one space: the
 *  clip scales to its box, the picture inside to its own, uniformly when
 *  `image` keeps the picture's proportion. */
export function peekMediaTransforms(
  laid: PeekRect,
  clip: PeekRect,
  image: PeekRect,
): { clip: string; image: string } {
  const clipWidth = side(clip.width);
  const clipHeight = side(clip.height);
  return {
    clip: peekBoxTransform(laid, clip),
    image: `translate(${round(((image.x - clip.x) * laid.width) / clipWidth)}px, ${round(((image.y - clip.y) * laid.height) / clipHeight)}px) scale(${round(side(image.width) / clipWidth)}, ${round(side(image.height) / clipHeight)})`,
  };
}

/** Where the card's picture stands at one end of the motion: the part shown
 *  (`clip`) and the whole picture (`image`). */
export interface PeekMediaPlace {
  clip: PeekRect;
  image: PeekRect;
}

/** The picture's place in the window when the window shows no frame for it
 *  (a gallery has none; an open card without a picture at the top): the
 *  card's crop carried into the window as the window carries the card, the
 *  whole picture covering it. */
export function carriedPeekMediaPlace(
  cardFrame: PeekRect,
  cardMedia: PeekMediaPlace,
  window: PeekRect,
  naturalWidth: number,
  naturalHeight: number,
): PeekMediaPlace {
  const scaleX = window.width / side(cardFrame.width);
  const scaleY = window.height / side(cardFrame.height);
  const clip = {
    x: window.x + (cardMedia.clip.x - cardFrame.x) * scaleX,
    y: window.y + (cardMedia.clip.y - cardFrame.y) * scaleY,
    width: cardMedia.clip.width * scaleX,
    height: cardMedia.clip.height * scaleY,
  };
  return { clip, image: coverPeekRect(clip, naturalWidth, naturalHeight) };
}

// ─── The spring ─────────────────────────────────────────────────────────

/** The motion's one spring (SPEC_CARD_PEEK.md, «Величины»): critically
 *  damped, `CARD_PEEK_SPRING_RESPONSE_S`, so from rest it lands in
 *  `CARD_PEEK_SPRING_MS`. `position` 0 is the card
 *  (or the place the window comes from), 1 the window at its place. */
export interface PeekSpring {
  position: number;
  velocity: number;
  target: 0 | 1;
}

const OMEGA = (2 * Math.PI) / CARD_PEEK_SPRING_RESPONSE_S;

/** The spring after `dtMs`, solved exactly: a critically damped spring from
 *  displacement d₀ and velocity v₀ is d(t) = (d₀ + (v₀ + ωd₀)t)·e^(−ωt).
 *  A new target keeps the position and the velocity, so a reversal brakes
 *  and turns back without a jump or a break in speed (О12). */
export function stepPeekSpring(spring: PeekSpring, dtMs: number): PeekSpring {
  const dt = Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, dtMs)) / 1000;
  const displacement = spring.position - spring.target;
  const b = spring.velocity + OMEGA * displacement;
  const decay = Math.exp(-OMEGA * dt);
  return {
    position: spring.target + (displacement + b * dt) * decay,
    velocity: (spring.velocity - OMEGA * b * dt) * decay,
    target: spring.target,
  };
}

/** Whether the spring has come to rest at its target: within the stack
 *  spring's settle threshold, and as slow as it is there. */
export function peekSpringSettled(spring: PeekSpring): boolean {
  return Math.abs(spring.position - spring.target) <= SPRING_SETTLE
    && Math.abs(spring.velocity) <= SPRING_SETTLE * OMEGA;
}

// ─── The content ────────────────────────────────────────────────────────

/** The content's opacity `elapsedMs` into an opening (`in`) or a closing
 *  (`out`) that began with the content at `startOpacity` (О10, п. 4; О11,
 *  п. 1): in, it shows over the last third of the movement and never dims
 *  below where it was; out, it is gone by the end of the first third. */
export function peekContentOpacity(direction: "in" | "out", elapsedMs: number, startOpacity: number): number {
  if (direction === "out") return startOpacity * clampUnit(1 - elapsedMs / CARD_PEEK_CONTENT_FADE_MS);
  return Math.max(
    startOpacity,
    clampUnit((elapsedMs - CARD_PEEK_CONTENT_IN_FROM_MS) / (CARD_PEEK_SPRING_MS - CARD_PEEK_CONTENT_IN_FROM_MS)),
  );
}

// ─── How it opens and closes ────────────────────────────────────────────

/** How the window moves: out of a card and back (`card`), out of the right
 *  part's centre at 95 % and back (`center`), in place by opacity alone
 *  (`fade`), or not at all (`instant`). */
export type PeekMotionKind = "card" | "center" | "fade" | "instant";

/** What opened the card: a click on its card in the feed or on the graph, a
 *  key in the feed, or something else (search, the sidebar, a step back). */
export type PeekOpeningFrom = "card" | "keyboard" | "elsewhere";

/** The input the page heard last, as the opening reads it. */
export interface PeekInput {
  kind: "pointer" | "key";
  /** When it came, `performance.now()` ms. */
  at: number;
  /** The feed card under the pointer, by its slug. */
  feedCardSlug: string | null;
  /** The pointer was on the graph's canvas. */
  onGraph: boolean;
  /** The key was pressed with the focus in the right part or nowhere. */
  inRightPart: boolean;
}

/** Where an opening of the card `slug` at `now` came from. */
export function peekOpeningFrom(input: PeekInput | null, slug: string, now: number): PeekOpeningFrom {
  if (!input || now - input.at > CARD_PEEK_INPUT_WINDOW_MS) return "elsewhere";
  if (input.kind === "pointer") return input.feedCardSlug === slug || input.onGraph ? "card" : "elsewhere";
  return input.inRightPart ? "keyboard" : "elsewhere";
}

/** How an opening goes (О10, О13): a card opened with the tab stands in
 *  place at once; with "Reduce motion" every window fades in place; a click
 *  on its card grows it out of the card; a key fades it in place; anything
 *  else brings it out of the centre. */
export function peekOpeningKind({
  from,
  restored,
  reducedMotion,
}: {
  from: PeekOpeningFrom;
  restored: boolean;
  reducedMotion: boolean;
}): PeekMotionKind {
  if (restored) return "instant";
  if (reducedMotion) return "fade";
  if (from === "card") return "card";
  if (from === "keyboard") return "fade";
  return "center";
}

/** What the page asks of a closing: the reverse of the opening (`return`),
 *  to the centre whatever the card (a collection or a view chosen in the
 *  top row: the card is not where it was), a fade in place (the window
 *  opened full page), or gone at once (a narrow window takes the card full). */
export type CardPeekExit = "return" | "center" | "fade" | "none";

/** How a closing goes (О11, О13): the way the window came, into the card
 *  where it stands when that card is on screen, else to the centre. */
export function peekClosingKind({
  openedAs,
  exit,
  reducedMotion,
  cardOnScreen,
}: {
  openedAs: PeekMotionKind;
  exit: CardPeekExit;
  reducedMotion: boolean;
  cardOnScreen: boolean;
}): Exclude<PeekMotionKind, "instant"> | "none" {
  if (exit === "none") return "none";
  if (reducedMotion || exit === "fade" || openedAs === "fade") return "fade";
  if (openedAs !== "card" || exit === "center") return "center";
  return cardOnScreen ? "card" : "center";
}

// ─── The input, the hidden card and the graph's cards ───────────────────

let lastInput: PeekInput | null = null;

/** Remember the input the page heard last (CardPeek reads it when a card
 *  opens). */
export function recordPeekInput(input: PeekInput): void {
  lastInput = input;
}

export function lastPeekInput(): PeekInput | null {
  return lastInput;
}

let hiddenSlug: string | null = null;
const hiddenListeners = new Set<() => void>();

/** The card the window grew out of, hidden in the feed and on the graph
 *  while the window stands for it (О14); null when none is. */
export function setPeekHiddenSlug(slug: string | null): void {
  if (slug === hiddenSlug) return;
  hiddenSlug = slug;
  for (const listener of hiddenListeners) listener();
}

export function getPeekHiddenSlug(): string | null {
  return hiddenSlug;
}

function subscribeHidden(listener: () => void) {
  hiddenListeners.add(listener);
  return () => {
    hiddenListeners.delete(listener);
  };
}

/** The hidden card's slug, heard by React. */
export function usePeekHiddenSlug(): string | null {
  return useSyncExternalStore(subscribeHidden, getPeekHiddenSlug, getPeekHiddenSlug);
}

/** Where a card stands on screen, for the window to grow out of it: its
 *  frame (viewport px), its corner, its fill and its picture. */
export interface PeekSource {
  rect: PeekRect;
  radius: number;
  /** The card's fill, a CSS colour. */
  fill: string;
  media: PeekSourceMedia | null;
  /** The line the card draws under its media (Card.tsx,
   *  `data-card-media-outline`): a copy of it, styled as the card styles
   *  it, and its box (viewport px). */
  outline?: { element: HTMLElement; rect: PeekRect };
}

/** The card's picture: what draws it, its own size and its place. A
 *  `composite` is several pictures as one (a gallery whose tiles hold no
 *  picture of the window's, as a copy of its tiles): the window has no
 *  single frame for it, so it fades under the content at the end. A gallery's tile of the window's
 *  own picture is the picture alone, and `rest` is what stands round it. */
export interface PeekSourceMedia extends PeekMediaPlace {
  /** What draws it; null for a gallery that flies whole as `copy`. */
  drawable: CanvasImageSource | null;
  /** A gallery's own elements to carry in place of a canvas: flying whole
   *  (`composite`), a copy of its tiles laid out from `clip`'s origin,
   *  `naturalWidth` by `naturalHeight` CSS px (`clip`'s size); from its
   *  tile, a copy of the tile's picture. */
  copy?: HTMLElement;
  naturalWidth: number;
  naturalHeight: number;
  composite: boolean;
  rest?: PeekSourceRest;
}

/** A gallery's other tiles and the seams between them, a copy of what the
 *  card shows round the tile the picture flies from, laid out from `rect`'s
 *  origin and clipped by it (viewport px): they stay at the card's place
 *  while the window moves (О10, п. 3; О11, п. 2). The tile itself is left
 *  clear. */
export interface PeekSourceRest {
  element: HTMLElement;
  rect: PeekRect;
}

type GraphSourceReader = (slug: string) => PeekSource | null;
let graphSourceReader: GraphSourceReader | null = null;

/** The graph tells where its cards stand (GraphView.tsx); the returned
 *  function takes it back. */
export function registerPeekGraphSource(reader: GraphSourceReader): () => void {
  graphSourceReader = reader;
  return () => {
    if (graphSourceReader === reader) graphSourceReader = null;
  };
}

/** Where the graph draws the card `slug`, when a graph is on screen. */
export function readPeekGraphSource(slug: string): PeekSource | null {
  return graphSourceReader?.(slug) ?? null;
}
