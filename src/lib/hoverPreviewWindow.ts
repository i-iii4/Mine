// The one hover preview window of the sidebar, the open card's panel and the
// graph (SPEC_CARD_STATES.md, С7.11). It lives while the pointer goes over the
// list or the graph. Only a new trigger in the attending mode changes anything,
// and then its card and its place change together, the place by one motion of a
// spring. The pointer moving inside a trigger moves nothing; a trigger that moves
// on its own, a node of the graph, takes the window with it every frame, with no
// lag. All three surfaces get the same timing and the same gating from here.
//
// This module decides: where the window stands, how its springs and fades go,
// which card it holds. The component (HoverPreviewWindow.tsx) renders the cards,
// measures them once at a change and writes what `paint` gives it. Only
// `transform` and `opacity` move; at rest the window is back on plain layout
// with nothing on a layer of its own.

import { SPRING_RESPONSE_S, springSettleMs } from "./channelIcon";
import { CARD_PEEK_FRAME_STEP_MS, clampUnit, lerp } from "./cardPeek";
import { FLOATING_LAYER_EDGE_PX } from "./floatingLayer";
import { HOVER_INTENT } from "./hoverIntent";
import type { HoverPreviewOpener } from "./hoverPreviewTiming";
import { prefersReducedMotion } from "./motion";

/** The window's width: С10.4, the sidebar's and the related notes' card. */
export const HOVER_PREVIEW_WINDOW_WIDTH_PX = 240;

/** Between the window and the panel it stands beside. */
export const HOVER_PREVIEW_WINDOW_GAP_PX = 8;

/** The spring from rest lands in this; no retarget for this long, it is over. */
export const HOVER_PREVIEW_WINDOW_SETTLE_MS = springSettleMs(SPRING_RESPONSE_S);

const OMEGA = (2 * Math.PI) / SPRING_RESPONSE_S;

// ─── Geometry ───────────────────────────────────────────────────────────

export type HoverPreviewSide = "after" | "before";

interface HorizontalSpan {
  left: number;
  right: number;
}

interface VerticalSpan {
  top: number;
  bottom: number;
}

/** Where the window stands beside `panel`: on the preferred side, else on the
 *  other, else `null`, when neither has room. */
export function hoverPreviewWindowLeft(
  panel: HorizontalSpan,
  viewportWidth: number,
  side: HoverPreviewSide,
): number | null {
  const after = panel.right + HOVER_PREVIEW_WINDOW_GAP_PX;
  const before = panel.left - HOVER_PREVIEW_WINDOW_GAP_PX - HOVER_PREVIEW_WINDOW_WIDTH_PX;
  const fitsAfter = after + HOVER_PREVIEW_WINDOW_WIDTH_PX <= viewportWidth - FLOATING_LAYER_EDGE_PX;
  const fitsBefore = before >= FLOATING_LAYER_EDGE_PX;
  if (side === "after") return fitsAfter ? after : fitsBefore ? before : null;
  return fitsBefore ? before : fitsAfter ? after : null;
}

/** With no room beside the panel: the window's right edge on the row's. */
export function hoverPreviewWindowRowLeft(row: HorizontalSpan, viewportWidth: number): number {
  return Math.max(
    FLOATING_LAYER_EDGE_PX,
    Math.min(row.right - HOVER_PREVIEW_WINDOW_WIDTH_PX, viewportWidth - FLOATING_LAYER_EDGE_PX - HOVER_PREVIEW_WINDOW_WIDTH_PX),
  );
}

/** A top kept off the app window's edges; a frame taller than the window keeps
 *  its top in reach. */
function clampedTop(top: number, height: number, viewportHeight: number): number {
  return Math.max(FLOATING_LAYER_EDGE_PX, Math.min(top, viewportHeight - FLOATING_LAYER_EDGE_PX - height));
}

/** The top of a frame `height` tall centred on `center`, kept off the edges. */
export function hoverPreviewWindowTop(center: number, height: number, viewportHeight: number): number {
  return clampedTop(center - height / 2, height, viewportHeight);
}

/** With no room beside the panel: under the row, or over it. */
export function hoverPreviewWindowRowTop(row: VerticalSpan, height: number, viewportHeight: number): number {
  const below = row.bottom + HOVER_PREVIEW_WINDOW_GAP_PX;
  return below + height <= viewportHeight - FLOATING_LAYER_EDGE_PX
    ? below
    : Math.max(FLOATING_LAYER_EDGE_PX, row.top - HOVER_PREVIEW_WINDOW_GAP_PX - height);
}

/** How much a card's media grows to fill a frame taller than the card, under
 *  the room the card keeps below it: uniformly, so its sides are cropped and
 *  nothing is stretched. A frame shorter than the card simply crops it. */
export function hoverPreviewCoverScale(frameHeight: number, cardHeight: number, mediaHeight: number): number {
  if (mediaHeight <= 0 || frameHeight <= cardHeight) return 1;
  return (frameHeight - (cardHeight - mediaHeight)) / mediaHeight;
}

// ─── The spring and the fades ───────────────────────────────────────────

export interface HoverPreviewSpring {
  position: number;
  /** Per second. */
  velocity: number;
  target: number;
}

function springAt(position: number): HoverPreviewSpring {
  return { position, velocity: 0, target: position };
}

/** The menu's spring (`SPRING_RESPONSE_S`) after `dtMs`, solved exactly: a
 *  critically damped spring from displacement d₀ and velocity v₀ is
 *  d(t) = (d₀ + (v₀ + ωd₀)t)·e^(−ωt). A new target keeps the position and the
 *  velocity, so a retarget never jumps or breaks the speed. */
export function stepHoverPreviewSpring(spring: HoverPreviewSpring, dtMs: number): HoverPreviewSpring {
  const dt = dtMs / 1000;
  const displacement = spring.position - spring.target;
  const b = spring.velocity + OMEGA * displacement;
  const decay = Math.exp(-OMEGA * dt);
  return {
    position: spring.target + (displacement + b * dt) * decay,
    velocity: (spring.velocity - OMEGA * b * dt) * decay,
    target: spring.target,
  };
}

interface Fade {
  value: number;
  from: number;
  to: number;
  ms: number;
  elapsed: number;
}

/** Thousandths of a pixel, so a place worked out to the same point reads 0. */
function roundedPx(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

function fadeTo(from: number, to: number, ms: number): Fade {
  return { value: from, from, to, ms, elapsed: 0 };
}

function stepFade(fade: Fade, dtMs: number): void {
  fade.elapsed += dtMs;
  fade.value = fade.ms <= 0 ? fade.to : lerp(fade.from, fade.to, clampUnit(fade.elapsed / fade.ms));
}

function fadeDone(fade: Fade): boolean {
  return fade.value === fade.to;
}

// ─── The window ─────────────────────────────────────────────────────────

/** What the pointer can be on: a row, a thumbnail of a row, a node of the graph. */
export interface HoverPreviewTarget {
  /** Its identity on the surface. */
  key: string;
  slug: string;
}

/** A trigger on the page: the window stands by its box. */
export interface HoverPreviewElementTarget extends HoverPreviewTarget {
  /** Read once, when its card comes on. */
  element: Element;
}

export interface HoverPreviewPlace {
  left: number;
  top: number;
  /** Which side of a moving trigger the window stands on, when it has one. */
  side?: "below" | "above";
}

/**
 * Where the window stands for `target` with a frame `height` tall, or `null` when
 * the target is gone. `change`: its card is coming on, layout may be read once.
 * `frame`: a tracked target's every frame, coordinates only.
 */
export type HoverPreviewPlacer<TTarget> = (
  target: TTarget,
  height: number,
  moment: "change" | "frame",
) => HoverPreviewPlace | null;

/** The sidebar's and the open card's panel's place: beside the panel, centred on
 *  the trigger; with no room there, under the row or over it. */
export function hoverPreviewBesidePanel<TTarget extends HoverPreviewElementTarget>(
  panel: () => HorizontalSpan | null,
  side: HoverPreviewSide,
): HoverPreviewPlacer<TTarget> {
  return (target, height) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const trigger = target.element.getBoundingClientRect();
    const span = panel();
    const beside = span ? hoverPreviewWindowLeft(span, viewportWidth, side) : null;
    return beside === null
      ? {
          left: hoverPreviewWindowRowLeft(trigger, viewportWidth),
          top: hoverPreviewWindowRowTop(trigger, height, viewportHeight),
        }
      : {
          left: beside,
          top: hoverPreviewWindowTop((trigger.top + trigger.bottom) / 2, height, viewportHeight),
        };
  };
}

export interface HoverPreviewWindowOptions<TTarget extends HoverPreviewTarget, TCard> {
  /** The shared cold delay, resting pointer and warm window (С7.10). */
  opener: HoverPreviewOpener;
  isAttending(): boolean;
  readCard(slug: string): Promise<TCard | null>;
  place: HoverPreviewPlacer<TTarget>;
  /** The target moves on its own: its place is read every frame the window is up. */
  tracksTarget?: boolean;
  /** The card now shown, or `null`: a row may mark its own. */
  onShown?(target: TTarget | null): void;
}

export interface HoverPreviewLayerView<TCard> {
  id: number;
  card: TCard;
  /** `pending` lies unseen until it is measured and decoded. */
  role: "pending" | "outgoing" | "current";
}

/** What the component renders; the geometry goes through `paint` instead. */
export interface HoverPreviewWindowView<TCard> {
  /** On screen: a window that only prepares its first card lies unseen. */
  shown: boolean;
  /** The frame stands in pieces while a card or a height changes. */
  frameMoving: boolean;
  radius: number;
  layers: readonly HoverPreviewLayerView<TCard>[];
}

/** What one frame writes. */
export interface HoverPreviewWindowPaint {
  left: number;
  laidTop: number;
  laidHeight: number;
  /** The shown frame's place, from `left` and `laidTop`. */
  translateX: number;
  translateY: number;
  /** The shown frame's height. */
  height: number;
  opacity: number;
  /** Something moves or fades: the window is on a layer for that long. */
  moving: boolean;
  frameMoving: boolean;
  layers: readonly { id: number; opacity: number; coverScale: number }[];
}

/** What the component reads of a card, once, when it is laid out unseen. */
export interface HoverPreviewMeasure {
  height: number;
  /** The media that fills the card, 0 when it has none. */
  mediaHeight: number;
  radius: number;
}

interface Layer<TCard> {
  id: number;
  card: TCard;
  fade: Fade;
  height: number;
  mediaHeight: number;
}

export class HoverPreviewWindow<TTarget extends HoverPreviewTarget, TCard> {
  private readonly options: HoverPreviewWindowOptions<TTarget, TCard>;
  private readonly listeners = new Set<() => void>();
  private painter: ((paint: HoverPreviewWindowPaint) => void) | null = null;
  private view: HoverPreviewWindowView<TCard> | null = null;

  /** `leaving` fades in place; a pointer back on a row brings it round. */
  private phase: "closed" | "open" | "leaving" = "closed";
  private frozen = false;

  private underPointer: TTarget | null = null;
  /** The target the opener is timing, while the window is not open. */
  private requestKey: string | null = null;
  private idleTimer: number | null = null;

  private shownTarget: TTarget | null = null;
  /** The card a leaving window still shows. */
  private fadingKey: string | null = null;
  private layers: Layer<TCard>[] = [];
  private pending: { id: number; target: TTarget; card: TCard } | null = null;
  private wantedKey: string | null = null;
  private readToken = 0;
  private nextLayerId = 1;

  private laidLeft = 0;
  private laidTop = 0;
  private laidHeight = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private radius = 0;
  private frameMoving = false;
  /** Where the shown trigger has the window stand. */
  private place: HoverPreviewPlace = { left: 0, top: 0 };

  /** The way left to the place, in both axes, each by its own spring: the place
   *  itself moves with a tracked trigger, so that movement has no lag. */
  private x = springAt(0);
  private y = springAt(0);
  private height = springAt(0);
  /** Spring time since the last retarget: past the settling, it is over. */
  private sinceRetargetMs = 0;
  private windowFade = fadeTo(1, 1, 0);

  private frame: number | null = null;
  private lastFrameAt = 0;
  /** Back on plain layout: a tracked window only watches its trigger. */
  private resting = true;

  constructor(options: HoverPreviewWindowOptions<TTarget, TCard>) {
    this.options = options;
  }

  // ─── For the component ────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getView = (): HoverPreviewWindowView<TCard> | null => this.view;

  setPainter(painter: ((paint: HoverPreviewWindowPaint) => void) | null): void {
    this.painter = painter;
  }

  /** The component rendered a new view: its new elements take the geometry. */
  repaint(): void {
    this.paint();
  }

  /** The pending card is laid out and decoded, or out of time. */
  prepared(id: number, measure: HoverPreviewMeasure): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) return;
    // The pointer has gone on: the card it left would be a flash.
    if (this.underPointer?.key !== pending.target.key) {
      this.dropPending();
      this.wantedKey = this.shownTarget?.key ?? null;
      this.requestKey = null;
      this.sync();
      return;
    }
    if (this.phase === "closed") this.appear(pending, measure);
    else this.swap(pending, measure);
  }

  // ─── For the surface ──────────────────────────────────────────────────

  /** The pointer's own step, on `target` or on no row. */
  pointer(target: TTarget | null): void {
    if (this.frozen) return;
    this.underPointer = target;
    this.sync();
  }

  /** The engine's attending mode changed, with or without a new step. */
  attendingChanged(): void {
    if (!this.frozen) this.sync();
  }

  /** The pointer left all rows, or the rows scrolled away: it fades in place. */
  leave(): void {
    if (this.frozen) return;
    this.underPointer = null;
    this.fadeOut();
  }

  /** Gone at once: a rebuilt list, a drag, an open menu (С7.5, С7.8). */
  dismiss(): void {
    this.clearIdle();
    this.options.opener.hide();
    this.underPointer = null;
    this.requestKey = null;
    this.wantedKey = null;
    this.readToken += 1;
    this.pending = null;
    this.close();
  }

  /** The trigger left the page: what belonged to it goes (С7.10). */
  forget(key: string): void {
    if (this.shownTarget?.key === key) {
      this.dismiss();
      return;
    }
    if (this.requestKey === key || this.pending?.target.key === key) {
      this.options.opener.cancel();
      this.requestKey = null;
      this.dropPending();
      this.wantedKey = this.shownTarget?.key ?? null;
    }
  }

  /** While a card menu holds the window nothing replaces it (SPEC_FRONTEND.md). */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (!frozen) return;
    this.clearIdle();
    this.options.opener.cancel();
    this.requestKey = null;
    this.dropPending();
    this.wantedKey = this.shownTarget?.key ?? null;
  }

  /** Drops a request on the way; a window on screen stays. */
  cancelPending(): void {
    this.options.opener.cancel();
    this.requestKey = null;
    this.dropPending();
    this.wantedKey = this.shownTarget?.key ?? null;
  }

  dispose(): void {
    this.dismiss();
    this.painter = null;
  }

  // ─── What the pointer asks for ────────────────────────────────────────

  private sync(): void {
    const target = this.underPointer;
    if (this.phase !== "open") {
      this.clearIdle();
      if (!target) {
        if (this.requestKey !== null || this.pending) {
          this.options.opener.hide();
          this.requestKey = null;
          this.wantedKey = null;
          this.dropPending();
        }
        return;
      }
      if (this.requestKey !== target.key) {
        this.requestKey = target.key;
        this.wantedKey = null;
        this.dropPending();
        this.options.opener.request(() => {
          if (this.underPointer) this.want(this.underPointer);
        });
      }
      return;
    }

    if (!target) {
      if (this.options.isAttending()) this.startIdle();
      else this.clearIdle();
      return;
    }
    this.clearIdle();
    if (!this.options.isAttending()) return;
    if (target.key === this.shownTarget?.key) {
      this.dropPending();
      this.wantedKey = target.key;
      return;
    }
    this.want(target);
  }

  private want(target: TTarget): void {
    if (this.phase === "leaving" && this.fadingKey === target.key) {
      this.windowFade = fadeTo(this.windowFade.value, 1, HOVER_INTENT.fadeInMs);
      this.phase = "open";
      // A tracked trigger went on moving during the fade: the way back to it.
      const place = this.options.tracksTarget ? this.options.place(target, this.height.target, "change") : null;
      if (place) this.goTo(place);
      this.settleOn(target);
      return;
    }
    if (this.wantedKey === target.key) return;
    this.wantedKey = target.key;
    this.dropPending();
    const token = ++this.readToken;
    const gaveNothing = () => {
      if (token !== this.readToken) return;
      this.wantedKey = this.shownTarget?.key ?? null;
    };
    void this.options.readCard(target.slug).then((card) => {
      if (token !== this.readToken) return;
      if (!card) {
        gaveNothing();
        return;
      }
      this.pending = { id: this.nextLayerId++, target, card };
      this.emit();
    }, gaveNothing);
  }

  private dropPending(): void {
    this.readToken += 1;
    if (!this.pending) return;
    this.pending = null;
    this.emit();
  }

  private startIdle(): void {
    if (this.idleTimer !== null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      this.fadeOut();
    }, HOVER_INTENT.leaveGraceMs);
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ─── Changes of the window ────────────────────────────────────────────

  private appear(pending: { id: number; target: TTarget; card: TCard }, measure: HoverPreviewMeasure): void {
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    const place = this.options.place(pending.target, measure.height, "change");
    if (!place) {
      this.dropPending();
      this.requestKey = null;
      this.wantedKey = null;
      return;
    }
    this.place = place;
    this.radius = measure.radius;
    this.layers = [this.layerOf(pending, measure, fadeTo(1, 1, 0))];
    this.pending = null;
    this.height = springAt(measure.height);
    this.sinceRetargetMs = HOVER_PREVIEW_WINDOW_SETTLE_MS;
    this.laidHeight = measure.height;
    this.layOutAt(this.clampedLeft(place.left), clampedTop(place.top, measure.height, this.viewportHeight));
    this.windowFade = fadeTo(0, 1, HOVER_INTENT.fadeInMs);
    this.phase = "open";
    this.frameMoving = false;
    this.settleOn(pending.target);
  }

  private swap(pending: { id: number; target: TTarget; card: TCard }, measure: HoverPreviewMeasure): void {
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    const place = this.options.place(pending.target, measure.height, "change");
    if (!place) {
      this.dropPending();
      this.wantedKey = this.shownTarget?.key ?? null;
      return;
    }
    if (this.phase === "leaving") {
      // Brought round on its way out, from where the fade had got to.
      this.windowFade = fadeTo(this.windowFade.value, 1, HOVER_INTENT.fadeInMs);
      this.phase = "open";
    }
    const current = this.layers[this.layers.length - 1];
    if (current) current.fade = fadeTo(current.fade.value, 0, HOVER_INTENT.fadeOutMs);
    this.layers = [
      ...(current ? [current] : []),
      this.layerOf(pending, measure, fadeTo(0, 1, HOVER_INTENT.fadeInMs)),
    ];
    this.pending = null;
    this.radius = measure.radius;
    this.frameMoving = true;
    const shownHeight = this.height.position;
    this.laidHeight = Math.max(shownHeight, measure.height);
    this.height = { ...this.height, target: measure.height };
    this.goTo(place);
    if (prefersReducedMotion()) {
      this.height = springAt(measure.height);
      this.x = springAt(0);
      this.y = springAt(0);
      this.sinceRetargetMs = HOVER_PREVIEW_WINDOW_SETTLE_MS;
    }
    this.settleOn(pending.target);
  }

  /** A new place from where the window is, at the speed it has. */
  private goTo(place: HoverPreviewPlace): void {
    this.x = { position: this.place.left + this.x.position - place.left, velocity: this.x.velocity, target: 0 };
    this.y = { position: this.place.top + this.y.position - place.top, velocity: this.y.velocity, target: 0 };
    this.place = place;
    this.sinceRetargetMs = 0;
  }

  /** Lays the window out there, whole pixels, and holds it to them. */
  private layOutAt(left: number, top: number): void {
    this.laidLeft = Math.round(left);
    this.laidTop = Math.round(top);
    this.x = springAt(this.laidLeft - this.place.left);
    this.y = springAt(this.laidTop - this.place.top);
  }

  private clampedLeft(left: number): number {
    return Math.max(
      FLOATING_LAYER_EDGE_PX,
      Math.min(left, this.viewportWidth - FLOATING_LAYER_EDGE_PX - HOVER_PREVIEW_WINDOW_WIDTH_PX),
    );
  }

  private layerOf(
    pending: { id: number; card: TCard },
    measure: HoverPreviewMeasure,
    fade: Fade,
  ): Layer<TCard> {
    return { id: pending.id, card: pending.card, fade, height: measure.height, mediaHeight: measure.mediaHeight };
  }

  /** After an appearance or a swap: what the surface and the frames see. */
  private settleOn(target: TTarget): void {
    this.requestKey = null;
    this.wantedKey = target.key;
    this.shownTarget = target;
    this.options.onShown?.(target);
    this.run();
    this.emit();
    this.paint();
  }

  private fadeOut(): void {
    this.clearIdle();
    this.options.opener.hide();
    this.requestKey = null;
    this.wantedKey = null;
    this.dropPending();
    if (this.phase !== "open") return;
    this.phase = "leaving";
    this.windowFade = fadeTo(this.windowFade.value, 0, HOVER_INTENT.fadeOutMs);
    // In place: the springs stop where they are.
    this.x = springAt(this.x.position);
    this.y = springAt(this.y.position);
    this.height = springAt(this.height.position);
    this.sinceRetargetMs = HOVER_PREVIEW_WINDOW_SETTLE_MS;
    this.fadingKey = this.shownTarget?.key ?? null;
    this.shownTarget = null;
    this.options.onShown?.(null);
    this.run();
  }

  private close(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const wasShown = this.shownTarget !== null;
    this.phase = "closed";
    this.layers = [];
    this.pending = null;
    this.frameMoving = false;
    this.shownTarget = null;
    this.resting = true;
    if (wasShown) this.options.onShown?.(null);
    this.emit();
  }

  // ─── The frames ───────────────────────────────────────────────────────

  private run(): void {
    this.resting = false;
    if (this.frame !== null) return;
    this.lastFrameAt = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    // A frame held up longer slows the motion for that frame instead of
    // jumping it ahead, as the card's window does.
    const dt = Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, now - this.lastFrameAt));
    this.lastFrameAt = now;
    if (!this.resting) this.advance(dt);
    if (this.phase === "leaving" && fadeDone(this.windowFade)) {
      this.close();
      return;
    }
    if (this.follow()) return;
    if (!this.resting && this.settled()) this.rest();
    else if (!this.resting) this.paint();
    if (!this.resting || this.options.tracksTarget) this.frame = requestAnimationFrame(this.tick);
  };

  /** A tracked trigger's place this frame. Answers whether its target is gone. */
  private follow(): boolean {
    const target = this.shownTarget;
    if (!this.options.tracksTarget || !target) return false;
    const next = this.options.place(target, this.height.target, "frame");
    if (!next) {
      this.dismiss();
      return true;
    }
    const place = this.place;
    if (next.left === place.left && next.top === place.top) return false;
    // Its own movement has no lag. Turning to the trigger's other side is a
    // change of place, so that part goes by the spring.
    if (next.side !== place.side) this.y = { ...this.y, position: this.y.position + place.top - next.top, target: 0 };
    this.place = next;
    this.sinceRetargetMs = 0;
    this.resting = false;
    return false;
  }

  private advance(dt: number): void {
    this.sinceRetargetMs += dt;
    if (this.sinceRetargetMs >= HOVER_PREVIEW_WINDOW_SETTLE_MS) {
      this.x = springAt(this.x.target);
      this.y = springAt(this.y.target);
      this.height = springAt(this.height.target);
    } else {
      this.x = stepHoverPreviewSpring(this.x, dt);
      this.y = stepHoverPreviewSpring(this.y, dt);
      this.height = stepHoverPreviewSpring(this.height, dt);
    }
    stepFade(this.windowFade, dt);
    for (const layer of this.layers) stepFade(layer.fade, dt);
  }

  private settled(): boolean {
    return this.sinceRetargetMs >= HOVER_PREVIEW_WINDOW_SETTLE_MS
      && fadeDone(this.windowFade)
      && this.layers.every((layer) => fadeDone(layer.fade));
  }

  /** Back on plain layout, nothing on a layer of its own. */
  private rest(): void {
    this.layers = this.layers.slice(-1);
    const height = this.height.position;
    this.laidHeight = height;
    const { left, top } = this.shownPlace(height);
    this.layOutAt(left, top);
    this.resting = true;
    const wasMoving = this.frameMoving;
    this.frameMoving = false;
    if (wasMoving) this.emit();
    this.paint();
  }

  private shownPlace(height: number): { left: number; top: number } {
    return {
      left: this.clampedLeft(this.place.left + this.x.position),
      top: clampedTop(this.place.top + this.y.position, height, this.viewportHeight),
    };
  }

  private paint(): void {
    const painter = this.painter;
    if (!painter || this.phase === "closed") return;
    const height = this.height.position;
    const { left, top } = this.shownPlace(height);
    painter({
      left: this.laidLeft,
      laidTop: this.laidTop,
      laidHeight: this.laidHeight,
      translateX: roundedPx(left - this.laidLeft),
      translateY: roundedPx(top - this.laidTop),
      height,
      opacity: this.windowFade.value,
      moving: !this.resting,
      frameMoving: this.frameMoving,
      layers: this.layers.map((layer) => ({
        id: layer.id,
        opacity: layer.fade.value,
        coverScale: this.frameMoving ? hoverPreviewCoverScale(height, layer.height, layer.mediaHeight) : 1,
      })),
    });
  }

  private emit(): void {
    const roles: HoverPreviewLayerView<TCard>[] = this.layers.map((layer, index) => ({
      id: layer.id,
      card: layer.card,
      role: index === this.layers.length - 1 ? "current" : "outgoing",
    }));
    if (this.pending) roles.push({ id: this.pending.id, card: this.pending.card, role: "pending" });
    this.view = roles.length === 0
      ? null
      : {
          shown: this.phase !== "closed",
          frameMoving: this.frameMoving,
          radius: this.radius,
          layers: roles,
        };
    for (const listener of this.listeners) listener();
  }
}
