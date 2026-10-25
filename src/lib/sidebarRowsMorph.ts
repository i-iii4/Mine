// POSTPONED (user's decision of 23.10.2026; compactStack.ts,
// COMPACT_TABLE_POSTPONED): the morph into the narrow table is out of use
// while the List look is developed; it switches at once in the List.
// The sidebar table's change between its wide rows and its narrow ones
// (user's decisions of 23.10.2026; global.css, «Compact rows», «Rows
// morph»): the rows' lines shorten from edge to edge to 16px in from the
// panel's edges, the column lines dissolve, the count fades, and the strip's
// thumbnails flatten into the stack, each of the first three onto its own
// card at its card's size, the rest under the bottom card where they fade.
// Widening runs the same path back. The name does not move.
//
// The container query switches the layout at once; this module only moves.
// The whole flight runs in the wide layout: narrowing holds it
// (`data-sidebar-morph` takes the list's container name away) and lets the
// narrow layout in once every part stands where the narrow one has it;
// widening is already there. So the strip, its clipping edge and its
// thumbnails, already loaded, are what flies, and the first frame is the old
// layout exactly. Every part moves by `transform` and fades by `opacity`
// only, on the compact stack's spring (channelIcon.ts), as one value: the
// narrowness `q`, 0 the wide rows, 1 the narrow ones. A crossing back
// mid-flight turns `q` around from where it is, at the speed it had.

import { sidebarCompactRowsBelowPx } from "./appLayout";
import { SPRING_RESPONSE_S, SPRING_SAMPLES, SPRING_SETTLE } from "./channelIcon";
import { getSidebarStyle } from "./compactStack";
import { prefersReducedMotion } from "./motion";

// ─── The spring ─────────────────────────────────────────────────────────

const OMEGA = (2 * Math.PI) / SPRING_RESPONSE_S;

/** The spring's distance from its target `t` seconds in, from −1 (the start)
 *  with velocity `v` per second: a critically damped spring from
 *  displacement d₀ and velocity v₀ is d(t) = (d₀ + (v₀ + ωd₀)t)·e^(−ωt). */
function springOffset(t: number, v: number): number {
  return (-1 + (v - OMEGA) * t) * Math.exp(-OMEGA * t);
}

/** Where the spring's settling is looked for, backwards from a time it has
 *  surely settled by: steps this fine of its response, then bisection. */
const SETTLE_SCAN_STEPS_PER_RESPONSE = 1000;
const SETTLE_BISECTIONS = 60;

/** When the spring from rest at −1 with velocity `v` comes within the
 *  settle threshold for good, seconds. `(1 + |v − ω|·t)·e^(−ωt)` bounds the
 *  offset and falls after its peak, so once it is under the threshold the
 *  spring is too; the last crossing before that is the settling time. */
function springSettleSeconds(v: number): number {
  const slope = Math.abs(v - OMEGA);
  const bound = (t: number) => (1 + slope * t) * Math.exp(-OMEGA * t);
  let late = slope > OMEGA ? (slope - OMEGA) / (slope * OMEGA) : 0;
  while (bound(late) > SPRING_SETTLE) late += SPRING_RESPONSE_S;
  const step = SPRING_RESPONSE_S / SETTLE_SCAN_STEPS_PER_RESPONSE;
  let low = late;
  while (low > 0 && Math.abs(springOffset(low, v)) <= SPRING_SETTLE) low = Math.max(0, low - step);
  let high = Math.min(late, low + step);
  for (let index = 0; index < SETTLE_BISECTIONS; index += 1) {
    const middle = (low + high) / 2;
    if (Math.abs(springOffset(middle, v)) > SPRING_SETTLE) low = middle;
    else high = middle;
  }
  return high;
}

/** One run of the spring from 0 to 1, as WAAPI plays it. */
export interface MorphSpring {
  /** Its settling time, ms: the animation's duration. */
  durationMs: number;
  /** The CSS `linear()` easing of evenly spaced samples, ending on 1. */
  easing: string;
  /** The eased progress `elapsedMs` in, as that easing renders it. */
  progress: (elapsedMs: number) => number;
  /** How fast the rendered progress changes `elapsedMs` in, per second. */
  speed: (elapsedMs: number) => number;
}

/** The compact stack's spring (channelIcon.ts: critically damped, response
 *  0.3s, settled within 0.1%, 40 samples) from progress 0 to 1, starting
 *  with velocity `v` (progress per second). At rest, `v` 0, it is the
 *  stack's own easing and duration. */
export function morphSpring(v = 0): MorphSpring {
  const settle = springSettleSeconds(v);
  const samples = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => (index === SPRING_SAMPLES
    ? 1
    : Math.round((1 + springOffset((index / SPRING_SAMPLES) * settle, v)) * 10000) / 10000));
  const durationMs = Math.round(settle * 1000);
  const segment = (elapsedMs: number) => {
    const at = Math.min(1, Math.max(0, elapsedMs / durationMs)) * SPRING_SAMPLES;
    const index = Math.min(SPRING_SAMPLES - 1, Math.floor(at));
    return { index, within: at - index };
  };
  return {
    durationMs,
    easing: `linear(${samples.join(", ")})`,
    progress(elapsedMs) {
      if (elapsedMs >= durationMs) return 1;
      const { index, within } = segment(elapsedMs);
      return samples[index]! + (samples[index + 1]! - samples[index]!) * within;
    },
    speed(elapsedMs) {
      if (elapsedMs >= durationMs || elapsedMs < 0) return 0;
      const { index } = segment(elapsedMs);
      return ((samples[index + 1]! - samples[index]!) * SPRING_SAMPLES) / (durationMs / 1000);
    },
  };
}

// ─── A part's look ──────────────────────────────────────────────────────

/** What a part shows at either end: a move, a scale and an opacity. */
export interface MorphLook {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

export const MORPH_REST: MorphLook = { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 };

/** The look `q` of the way from `wide` to `narrow`. */
export function mixLook(wide: MorphLook, narrow: MorphLook, q: number): MorphLook {
  const mix = (a: number, b: number) => a + (b - a) * q;
  return {
    x: mix(wide.x, narrow.x),
    y: mix(wide.y, narrow.y),
    scaleX: mix(wide.scaleX, narrow.scaleX),
    scaleY: mix(wide.scaleY, narrow.scaleY),
    opacity: mix(wide.opacity, narrow.opacity),
  };
}

/** A box in its row's coordinates, px. */
export interface RowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The lines' insets from the row's edges, px (`[data-sidebar-row-surface]::after`). */
export interface LineInsets {
  left: number;
  right: number;
}

/** The look that lays the wide line (its insets in a row `rowWidth` wide)
 *  over the narrow one, scaled from its left end. */
export function lineLook(rowWidth: number, wide: LineInsets, narrow: LineInsets): MorphLook {
  const wideWidth = rowWidth - wide.left - wide.right;
  const narrowWidth = rowWidth - narrow.left - narrow.right;
  return { ...MORPH_REST, x: narrow.left - wide.left, scaleX: wideWidth > 0 ? narrowWidth / wideWidth : 1 };
}

const centreX = (box: RowBox) => box.x + box.width / 2;
const centreY = (box: RowBox) => box.y + box.height / 2;

/** The strip's narrow looks: the strip itself moves so its first thumbnail
 *  lands on the stack's top card, carrying its clipping edge along, and each
 *  thumbnail moves inside it onto its card at its card's size; those past the
 *  stack's cards go under the bottom one and fade. A thumbnail its edge
 *  hides in the wide rows stays hidden on the way (`wideOpacity` 0). */
export function stripLooks(strip: RowBox, tiles: RowBox[], cards: RowBox[]): {
  strip: MorphLook;
  tiles: { wide: MorphLook; narrow: MorphLook }[];
} {
  const top = cards[0]!;
  const first = tiles[0]!;
  const shift = { x: centreX(top) - centreX(first), y: centreY(top) - centreY(first) };
  return {
    strip: { ...MORPH_REST, ...shift },
    tiles: tiles.map((tile, index) => {
      const card = cards[Math.min(index, cards.length - 1)]!;
      const onCard = index < cards.length;
      const scale = card.width / tile.width;
      return {
        wide: { ...MORPH_REST, opacity: onCard || tile.x < strip.x + strip.width ? 1 : 0 },
        narrow: {
          x: centreX(card) - centreX(tile) - shift.x,
          y: centreY(card) - centreY(tile) - shift.y,
          scaleX: scale,
          scaleY: scale,
          opacity: onCard ? 1 : 0,
        },
      };
    }),
  };
}

// ─── The DOM ────────────────────────────────────────────────────────────

/** On the list's scrollport while the rows move: holds the wide layout. */
const MORPH_ATTRIBUTE = "data-sidebar-morph";
/** On it for the moment the layouts are read: the strip's moves step aside. */
const MEASURE_ATTRIBUTE = "data-sidebar-morph-measure";

const ROW_SELECTOR = "[data-sidebar-row-surface]";
const STRIP_SELECTOR = "[data-sidebar-thumbnail-strip]";
/** The strip's tiles stand in its track (Sidebar.tsx). */
const TILES_SELECTOR = "[data-sidebar-strip-track] > *";
const CARD_SELECTOR = "[data-sidebar-compact-stack] [data-channel-icon-card]";

interface Part {
  element: Element;
  pseudoElement?: "::after" | "::before";
  moves: boolean;
  fades: boolean;
  origin?: string;
  /** The part's own opacity when the morph took it (the count under
   *  Connect, a dragged thumbnail): the look's opacity is a share of it. */
  own: number;
  wide: MorphLook;
  narrow: MorphLook;
  animation: Animation | null;
}

/** A part's frame. Its own transform is none; its opacity is the look's
 *  share of its own. */
function keyframe(part: Part, look: MorphLook): Keyframe {
  const frame: Keyframe = {};
  if (part.moves) {
    frame.transform = `translate(${look.x}px, ${look.y}px) scale(${look.scaleX}, ${look.scaleY})`;
    if (part.origin) frame.transformOrigin = part.origin;
  }
  if (part.fades) frame.opacity = look.opacity * part.own;
  return frame;
}

/** What the element's own style makes its opacity: read before the morph
 *  animates it, or between two of its runs. */
function ownOpacity(element: Element): number {
  const opacity = parseFloat(getComputedStyle(element).opacity);
  return Number.isFinite(opacity) ? opacity : 1;
}

function rowBox(element: Element, row: DOMRect): RowBox {
  const rect = element.getBoundingClientRect();
  return { x: rect.left - row.left, y: rect.top - row.top, width: rect.width, height: rect.height };
}

function lineInsets(row: Element): LineInsets {
  const style = getComputedStyle(row, "::after");
  return { left: parseFloat(style.left) || 0, right: parseFloat(style.right) || 0 };
}

interface WideRow {
  width: number;
  line: LineInsets;
  strip: RowBox | null;
  tiles: RowBox[];
}

/** A row's narrow layout as a function of its width: the stack stands at
 *  one end, so each card's place is linear in the width, read at two. */
interface NarrowRow {
  line: LineInsets;
  width: number;
  cards: (RowBox & { slope: number })[];
}

function narrowCardsAt(row: NarrowRow, width: number): RowBox[] {
  return row.cards.map(({ slope, ...card }) => ({ ...card, x: card.x + slope * (width - row.width) }));
}

function readWide(row: HTMLElement): WideRow {
  const rect = row.getBoundingClientRect();
  const strip = row.querySelector(STRIP_SELECTOR);
  return {
    width: rect.width,
    line: lineInsets(row),
    strip: strip ? rowBox(strip, rect) : null,
    tiles: strip ? Array.from(strip.querySelectorAll(TILES_SELECTOR), (tile) => rowBox(tile, rect)) : [],
  };
}

function readNarrowCards(row: HTMLElement): { width: number; cards: RowBox[] } {
  const rect = row.getBoundingClientRect();
  return { width: rect.width, cards: Array.from(row.querySelectorAll(CARD_SELECTOR), (card) => rowBox(card, rect)) };
}

/** Whether WAAPI animates a pseudo-element here (the rows' lines, the
 *  thumbnails' shadows). Without it those parts change with the layout. */
function animatesPseudoElements(element: Element): boolean {
  try {
    return new KeyframeEffect(element, null, { pseudoElement: "::after" }).pseudoElement === "::after";
  } catch {
    return false;
  }
}

interface Segment {
  q0: number;
  q1: number;
  spring: MorphSpring;
  /** One of the segment's animations, whose time is all of theirs: made in
   *  one task, they start together on the frame that first shows them. */
  clock: Animation | null;
}

interface Morph {
  rows: HTMLElement[];
  narrow: Map<HTMLElement, NarrowRow>;
  /** Each thumbnail's opacity in the wide rows, settled when the morph
   *  begins (`stripLooks`). */
  shown: Map<Element, number>;
  parts: Part[];
  segment: Segment;
}

/** Watches the list's scrollport `nav` and moves its rows across the
 *  compact threshold. Returns the teardown. Does nothing where WAAPI or
 *  ResizeObserver is missing, with "Reduce motion" (the layout switches at
 *  once) and in the List look on trial, which is not the narrow table. */
export function observeSidebarRowsMorph(nav: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined" || typeof nav.animate !== "function" || typeof KeyframeEffect === "undefined") {
    return () => {};
  }
  const threshold = sidebarCompactRowsBelowPx();
  const pseudo = animatesPseudoElements(nav);
  let lastNarrow: boolean | null = null;
  let morph: Morph | null = null;

  const visibleRows = (): HTMLElement[] => {
    const port = nav.getBoundingClientRect();
    return Array.from(nav.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > port.top && rect.top < port.bottom;
    });
  };

  /** Reads the rows' wide layout and, unless kept, their narrow one at two
   *  widths, with the scrollport held to each in turn. Leaves the wide
   *  layout held. Nothing is painted in between. */
  const measure = (rows: HTMLElement[], keep: Map<HTMLElement, NarrowRow> | null) => {
    nav.setAttribute(MEASURE_ATTRIBUTE, "");
    nav.setAttribute(MORPH_ATTRIBUTE, "");
    const wide = new Map(rows.map((row) => [row, readWide(row)]));
    let narrow = keep;
    if (!narrow) {
      nav.removeAttribute(MORPH_ATTRIBUTE);
      const { maxWidth, minWidth } = nav.style;
      nav.style.minWidth = "0px";
      const near = Math.min(nav.getBoundingClientRect().width, threshold - 1);
      nav.style.maxWidth = `${near}px`;
      const lines = new Map(rows.map((row) => [row, lineInsets(row)]));
      const atNear = new Map(rows.map((row) => [row, readNarrowCards(row)]));
      nav.style.maxWidth = `${near / 2}px`;
      const atFar = new Map(rows.map((row) => [row, readNarrowCards(row)]));
      nav.style.maxWidth = maxWidth;
      nav.style.minWidth = minWidth;
      nav.setAttribute(MORPH_ATTRIBUTE, "");
      narrow = new Map(rows.map((row) => {
        const a = atNear.get(row)!;
        const b = atFar.get(row)!;
        const run = a.width - b.width;
        return [row, {
          line: lines.get(row)!,
          width: a.width,
          cards: a.cards.map((card, index) => ({
            ...card,
            slope: run !== 0 && b.cards[index] ? (card.x - b.cards[index]!.x) / run : 0,
          })),
        }];
      }));
    }
    nav.removeAttribute(MEASURE_ATTRIBUTE);
    return { wide, narrow };
  };

  /** Every part of `rows` with its two looks, from their layouts. */
  const buildParts = (
    rows: HTMLElement[],
    wide: Map<HTMLElement, WideRow>,
    narrow: Map<HTMLElement, NarrowRow>,
    shown: Map<Element, number>,
  ): Part[] => {
    const parts: Part[] = [];
    const fade = (element: Element | null) => {
      if (element) parts.push({ element, moves: false, fades: true, own: ownOpacity(element), wide: MORPH_REST, narrow: { ...MORPH_REST, opacity: 0 }, animation: null });
    };
    fade(nav.querySelector("[data-sidebar-guidelines]"));
    for (const row of rows) {
      const w = wide.get(row)!;
      const n = narrow.get(row)!;
      if (pseudo) {
        parts.push({ element: row, pseudoElement: "::after", moves: true, fades: false, origin: "0 0", own: 1, wide: MORPH_REST, narrow: lineLook(w.width, w.line, n.line), animation: null });
      }
      fade(row.querySelector("[data-sidebar-meta-count]"));
      fade(row.querySelector("[data-sidebar-editable-row-guideline]"));
      const strip = row.querySelector(STRIP_SELECTOR);
      const cards = narrowCardsAt(n, w.width);
      if (!strip || !w.strip || w.tiles.length === 0 || cards.length === 0) continue;
      const looks = stripLooks(w.strip, w.tiles, cards);
      parts.push({ element: strip, moves: true, fades: false, own: 1, wide: MORPH_REST, narrow: looks.strip, animation: null });
      Array.from(strip.querySelectorAll(TILES_SELECTOR)).forEach((tile, index) => {
        const look = looks.tiles[index];
        if (!look) return;
        // The opacity stands in for the strip's edge, so whether the edge
        // shows a thumbnail is settled once: as the width moves on, no
        // thumbnail appears or vanishes at once. One it hides goes along
        // unseen.
        const opacity = shown.get(tile) ?? look.wide.opacity;
        shown.set(tile, opacity);
        parts.push({ element: tile, moves: true, fades: true, own: ownOpacity(tile), wide: { ...look.wide, opacity }, narrow: look.narrow, animation: null });
        if (pseudo && index < cards.length) {
          // The card's shadow comes with the stack (global.css, «Rows morph»).
          parts.push({ element: tile, pseudoElement: "::before", moves: false, fades: true, own: 1, wide: { ...MORPH_REST, opacity: 0 }, narrow: MORPH_REST, animation: null });
        }
      });
    }
    return parts;
  };

  const animate = (parts: Part[], segment: Segment) => {
    for (const part of parts) {
      part.animation = part.element.animate(
        [keyframe(part, mixLook(part.wide, part.narrow, segment.q0)), keyframe(part, mixLook(part.wide, part.narrow, segment.q1))],
        { duration: segment.spring.durationMs, easing: segment.spring.easing, fill: "both", pseudoElement: part.pseudoElement },
      );
    }
    segment.clock = parts.find((part) => part.animation)?.animation ?? null;
  };

  const release = () => {
    if (!morph) return;
    const { parts } = morph;
    morph = null;
    nav.removeEventListener("scroll", release);
    nav.removeAttribute(MORPH_ATTRIBUTE);
    for (const part of parts) part.animation?.cancel();
  };

  /** The segment has landed. Narrow, the stack's pictures that are in are
   *  decoded first, so the layout's swap shows them at once. */
  const land = (current: Morph) => {
    if (morph !== current) return;
    if (current.segment.q1 === 0) {
      release();
      return;
    }
    const images = current.rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLImageElement>(`${CARD_SELECTOR} img`)));
    void Promise.all(images.filter((image) => image.complete).map((image) => image.decode().catch(() => undefined))).then(() => {
      if (morph === current) release();
    });
  };

  /** `fromRest`: the parts hold their first frame until the next one. The
   *  frame that crossed the threshold lays the list out anew and may take
   *  long; an animation started on it would show its first frame already
   *  under way. A turn mid-flight goes on at once, at the speed it had. */
  const run = (current: Morph, fromRest: boolean) => {
    animate(current.parts, current.segment);
    const animations = current.parts.flatMap((part) => (part.animation ? [part.animation] : []));
    if (animations.length === 0) {
      land(current);
      return;
    }
    if (fromRest) {
      for (const animation of animations) animation.pause();
      requestAnimationFrame((time) => {
        if (morph !== current) return;
        for (const animation of animations) animation.startTime = time;
      });
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(() => land(current), () => undefined);
  };

  /** Moves toward `toNarrow` from narrowness `q0` at speed `speed` (per
   *  second), the layouts read afresh. */
  const start = (toNarrow: boolean, q0: number, speed: number) => {
    const q1 = toNarrow ? 1 : 0;
    const rows = morph?.rows ?? visibleRows();
    if (morph) for (const part of morph.parts) part.animation?.cancel();
    const { wide, narrow } = measure(rows, null);
    const span = q1 - q0;
    const segment: Segment = { q0, q1, spring: morphSpring(span !== 0 ? speed / span : 0), clock: null };
    if (!morph) nav.addEventListener("scroll", release, { passive: true });
    const shown = morph?.shown ?? new Map<Element, number>();
    morph = { rows, narrow, shown, parts: buildParts(rows, wide, narrow, shown), segment };
    run(morph, speed === 0 && (q0 === 0 || q0 === 1));
  };

  /** The narrowness now and how fast it changes, per second. */
  const now = (segment: Segment) => {
    const elapsed = Number(segment.clock?.currentTime ?? 0);
    const span = segment.q1 - segment.q0;
    return { q: segment.q0 + segment.spring.progress(elapsed) * span, speed: segment.spring.speed(elapsed) * span };
  };

  /** The width changed on the same side: the parts' ends follow the layouts
   *  and the movement goes on in time. */
  const retarget = (current: Morph) => {
    const { wide } = measure(current.rows, current.narrow);
    const parts = buildParts(current.rows, wide, current.narrow, current.shown);
    // The same rows give the same parts unless the rows changed under the
    // movement; then the parts are laid anew from where they are.
    if (parts.length !== current.parts.length || parts.some((part, index) => part.element !== current.parts[index]!.element || part.pseudoElement !== current.parts[index]!.pseudoElement)) {
      const { q, speed } = now(current.segment);
      start(current.segment.q1 === 1, q, speed);
      return;
    }
    const { q0, q1 } = current.segment;
    parts.forEach((part, index) => {
      const live = current.parts[index]!;
      live.wide = part.wide;
      live.narrow = part.narrow;
      // `Element.animate` always makes a KeyframeEffect; the DOM types the
      // effect as the base AnimationEffect.
      (live.animation?.effect as KeyframeEffect | null)?.setKeyframes([
        keyframe(live, mixLook(live.wide, live.narrow, q0)),
        keyframe(live, mixLook(live.wide, live.narrow, q1)),
      ]);
    });
  };

  const onWidth = (width: number) => {
    const narrow = width < threshold;
    const crossed = lastNarrow !== null && narrow !== lastNarrow;
    lastNarrow = narrow;
    if (prefersReducedMotion() || getSidebarStyle() === "list") {
      release();
      return;
    }
    if (morph) {
      const toNarrow = morph.segment.q1 === 1;
      if (narrow !== toNarrow) {
        const { q, speed } = now(morph.segment);
        start(narrow, q, speed);
      } else {
        retarget(morph);
      }
      return;
    }
    if (crossed) start(narrow, narrow ? 0 : 1, 0);
  };

  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    onWidth(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
  });
  observer.observe(nav);
  return () => {
    observer.disconnect();
    release();
  };
}
