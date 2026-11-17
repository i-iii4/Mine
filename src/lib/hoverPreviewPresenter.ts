// What the hover preview window shows and how it moves (SPEC_OUTSIDE_WINDOW.md,
// НО6): its layers of content, the measure and the wait for a card's pictures,
// its springs and fades, and the writes of each frame. What the window shows
// and when, the pointer's part, lives in hoverPreviewWindow.ts and drives this
// through `HoverPreviewStage`. Inside the app window the two sit in one page;
// outside it (SPEC_OUTSIDE_WINDOW.md, ПН2) this part runs in the outside
// window's page and hears the same calls as messages, so the window moves the
// same in both (ПН7).
//
// Only `transform` and `opacity` move; at rest the window is back on plain
// layout with nothing on a layer of its own (SPEC_CARD_STATES.md, С7.11).

import { SPRING_RESPONSE_S, springSettleMs } from "./spring";
import { CARD_PEEK_FRAME_STEP_MS, clampUnit, lerp } from "./cardPeek";
import { FLOATING_LAYER_EDGE_PX } from "./floatingLayer";
import { roleMs } from "./motion";

/** The window's width: С10.4, the sidebar's and the related notes' card. */
export const HOVER_PREVIEW_WINDOW_WIDTH_PX = 240;

/** The spring from rest lands in this; no retarget for this long, it is over. */
export const HOVER_PREVIEW_WINDOW_SETTLE_MS = springSettleMs(SPRING_RESPONSE_S);

const OMEGA = (2 * Math.PI) / SPRING_RESPONSE_S;

// ─── Where the window may stand ─────────────────────────────────────────

/** The area the window keeps inside, its edges already in from the bound. */
export interface HoverPreviewArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Inside the app window: its viewport, `FLOATING_LAYER_EDGE_PX` in. */
export function hoverPreviewViewportArea(): HoverPreviewArea {
  return {
    left: FLOATING_LAYER_EDGE_PX,
    top: FLOATING_LAYER_EDGE_PX,
    right: window.innerWidth - FLOATING_LAYER_EDGE_PX,
    bottom: window.innerHeight - FLOATING_LAYER_EDGE_PX,
  };
}

/** A top kept inside `area`; a frame taller than the area keeps its top in
 *  reach. */
export function hoverPreviewClampTop(top: number, height: number, area: Pick<HoverPreviewArea, "top" | "bottom">): number {
  return Math.max(area.top, Math.min(top, area.bottom - height));
}

/** A left kept inside `area` for the window's width. */
export function hoverPreviewClampLeft(left: number, area: Pick<HoverPreviewArea, "left" | "right">): number {
  return Math.max(area.left, Math.min(left, area.right - HOVER_PREVIEW_WINDOW_WIDTH_PX));
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

/** A fade of no length stands at its end from the start: at Off the window
 *  and its content show and go in the frame of the change (Н1, Н2). */
function fadeTo(from: number, to: number, ms: number): Fade {
  return { value: ms <= 0 ? to : from, from, to, ms, elapsed: 0 };
}

/** The window's and its content's fade in and fade out: Отклик, 150/100. The
 *  window answers the pointer, so it moves the same in every mode
 *  (SPEC_MOTION_LEVELS.md, «Режимы», Н1, Н2). `HOVER_INTENT` keeps the same
 *  values for the graph (УД9); a test keeps them equal (РД8). */
function fadeInMs(): number {
  return roleMs("response", "enter", { answers: true });
}

function fadeOutMs(): number {
  return roleMs("response", "exit", { answers: true });
}

function stepFade(fade: Fade, dtMs: number): void {
  fade.elapsed += dtMs;
  fade.value = fade.ms <= 0 ? fade.to : lerp(fade.from, fade.to, clampUnit(fade.elapsed / fade.ms));
}

function fadeDone(fade: Fade): boolean {
  return fade.value === fade.to;
}

// ─── What the window stands by ──────────────────────────────────────────

/** What the pointer can be on: a row, a thumbnail of a row, a node of the graph. */
export interface HoverPreviewTarget {
  /** Its identity on the surface. */
  key: string;
  slug: string;
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

/** What the component that draws the window needs of what it draws. */
export interface HoverPreviewDrawn<TCard> {
  subscribe(listener: () => void): () => void;
  getView(): HoverPreviewWindowView<TCard> | null;
  setPainter(painter: ((paint: HoverPreviewWindowPaint) => void) | null): void;
  /** The component rendered a new view: its new elements take the geometry. */
  repaint(): void;
  /** The pending card is laid out and decoded, or out of time. */
  prepared(id: number, measure: HoverPreviewMeasure): void;
}

export type HoverPreviewPhase = "closed" | "open" | "leaving";

/** Why a card offered to the window was not shown. */
export type HoverPreviewDropReason =
  /** The pointer had gone on by the time it was ready: it would be a flash. */
  | "left"
  /** Its target had no place, on a window that was not on screen. */
  | "unplaced-closed"
  /** Its target had no place, the window on screen kept its card. */
  | "unplaced-open";

/**
 * What the pointer's part drives: the window, here or in the outside window's
 * page. Every call is answered at once by the window's own state.
 */
export interface HoverPreviewStage<TTarget extends HoverPreviewTarget, TCard> {
  phase(): HoverPreviewPhase;
  /** The trigger whose card is on screen, `null` while closed or leaving. */
  shownKey(): string | null;
  /** The card a leaving window still shows. */
  fadingKey(): string | null;
  /** A card laid out unseen, waiting to be measured and decoded. */
  pendingKey(): string | null;
  /** `card` comes on for `target` once it is measured and decoded. */
  offer(target: TTarget, card: TCard): void;
  dropPending(): void;
  /** A leaving window comes back round to its own trigger, in place. */
  bringBack(target: TTarget): void;
  /** Fades in place; its springs stop where they are. */
  fadeOut(): void;
  /** Gone at once. */
  close(): void;
  /** The trigger the pointer is on now changed. A window in this page asks
   *  `stillWanted` itself; one on another page hears it. */
  pointerOn?(key: string | null): void;
}

/** What the window tells the pointer's part. */
export interface HoverPreviewStageHost<TTarget extends HoverPreviewTarget> {
  /** The trigger a ready card belongs to is still the one wanted. */
  stillWanted(key: string): boolean;
  /** A card came on screen for `target`, appearing or by a change. */
  onSettled(target: TTarget): void;
  /** The window's card left the screen: it began to fade or it closed. */
  onHidden(): void;
  /** An offered card was not shown. */
  onDropped(reason: HoverPreviewDropReason): void;
  /** A tracked target is gone from the page. */
  onTargetGone(): void;
  /** The window that was open or leaving closed: a showing is over. */
  onClosed?(): void;
}

export interface HoverPreviewPresenterOptions<TTarget extends HoverPreviewTarget> {
  place: HoverPreviewPlacer<TTarget>;
  /** The target moves on its own: its place is read every frame the window is up. */
  tracksTarget?: boolean;
  /** Where the window may stand, read at each change of card; the app
   *  window's viewport when not given. */
  area?: () => HoverPreviewArea;
}

interface Layer<TCard> {
  id: number;
  card: TCard;
  fade: Fade;
  height: number;
  mediaHeight: number;
}

/** The window itself: what `HoverPreviewStage` drives and the component draws. */
export class HoverPreviewPresenter<TTarget extends HoverPreviewTarget, TCard>
implements HoverPreviewStage<TTarget, TCard>, HoverPreviewDrawn<TCard> {
  private readonly options: HoverPreviewPresenterOptions<TTarget>;
  private host: HoverPreviewStageHost<TTarget> | null = null;
  private readonly listeners = new Set<() => void>();
  private painter: ((paint: HoverPreviewWindowPaint) => void) | null = null;
  private view: HoverPreviewWindowView<TCard> | null = null;

  /** `leaving` fades in place; a pointer back on a row brings it round. */
  private state: HoverPreviewPhase = "closed";
  private shownTarget: TTarget | null = null;
  private fading: string | null = null;
  private layers: Layer<TCard>[] = [];
  private pending: { id: number; target: TTarget; card: TCard } | null = null;
  private nextLayerId = 1;

  private laidLeft = 0;
  private laidTop = 0;
  private laidHeight = 0;
  private area: HoverPreviewArea = { left: 0, top: 0, right: 0, bottom: 0 };
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

  constructor(options: HoverPreviewPresenterOptions<TTarget>) {
    this.options = options;
  }

  /** The pointer's part that drives this window. */
  setHost(host: HoverPreviewStageHost<TTarget> | null): void {
    this.host = host;
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

  repaint(): void {
    this.paint();
  }

  prepared(id: number, measure: HoverPreviewMeasure): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) return;
    // The pointer has gone on: the card it left would be a flash.
    if (!(this.host?.stillWanted(pending.target.key) ?? true)) {
      this.dropPending();
      this.host?.onDropped("left");
      return;
    }
    if (this.state === "closed") this.appear(pending, measure);
    else this.swap(pending, measure);
  }

  // ─── The stage ────────────────────────────────────────────────────────

  phase(): HoverPreviewPhase {
    return this.state;
  }

  shownKey(): string | null {
    return this.shownTarget?.key ?? null;
  }

  fadingKey(): string | null {
    return this.fading;
  }

  pendingKey(): string | null {
    return this.pending?.target.key ?? null;
  }

  offer(target: TTarget, card: TCard): void {
    this.pending = { id: this.nextLayerId++, target, card };
    this.emit();
  }

  dropPending(): void {
    if (!this.pending) return;
    this.pending = null;
    this.emit();
  }

  bringBack(target: TTarget): void {
    this.windowFade = fadeTo(this.windowFade.value, 1, fadeInMs());
    this.state = "open";
    // A tracked trigger went on moving during the fade: the way back to it.
    const place = this.options.tracksTarget ? this.options.place(target, this.height.target, "change") : null;
    if (place) this.goTo(place);
    this.settleOn(target);
  }

  fadeOut(): void {
    this.dropPending();
    if (this.state !== "open") return;
    const outMs = fadeOutMs();
    // At Off nothing fades: the window goes in this frame (Н1).
    if (outMs <= 0) {
      this.close();
      return;
    }
    this.state = "leaving";
    this.windowFade = fadeTo(this.windowFade.value, 0, outMs);
    // In place: the springs stop where they are.
    this.x = springAt(this.x.position);
    this.y = springAt(this.y.position);
    this.height = springAt(this.height.position);
    this.sinceRetargetMs = HOVER_PREVIEW_WINDOW_SETTLE_MS;
    this.fading = this.shownTarget?.key ?? null;
    this.shownTarget = null;
    this.host?.onHidden();
    this.run();
  }

  close(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const wasShown = this.shownTarget !== null;
    const wasOpen = this.state !== "closed";
    this.state = "closed";
    this.layers = [];
    this.pending = null;
    this.frameMoving = false;
    this.shownTarget = null;
    this.resting = true;
    if (wasShown) this.host?.onHidden();
    if (wasOpen) this.host?.onClosed?.();
    this.emit();
  }

  dispose(): void {
    this.close();
    this.painter = null;
    this.host = null;
  }

  // ─── Changes of the window ────────────────────────────────────────────

  private appear(pending: { id: number; target: TTarget; card: TCard }, measure: HoverPreviewMeasure): void {
    this.area = this.readArea();
    const place = this.options.place(pending.target, measure.height, "change");
    if (!place) {
      this.dropPending();
      this.host?.onDropped("unplaced-closed");
      return;
    }
    this.place = place;
    this.radius = measure.radius;
    this.layers = [this.layerOf(pending, measure, fadeTo(1, 1, 0))];
    this.pending = null;
    this.height = springAt(measure.height);
    this.sinceRetargetMs = HOVER_PREVIEW_WINDOW_SETTLE_MS;
    this.laidHeight = measure.height;
    this.layOutAt(hoverPreviewClampLeft(place.left, this.area), hoverPreviewClampTop(place.top, measure.height, this.area));
    this.windowFade = fadeTo(0, 1, fadeInMs());
    this.state = "open";
    this.frameMoving = false;
    this.settleOn(pending.target);
  }

  private swap(pending: { id: number; target: TTarget; card: TCard }, measure: HoverPreviewMeasure): void {
    this.area = this.readArea();
    const place = this.options.place(pending.target, measure.height, "change");
    if (!place) {
      this.dropPending();
      this.host?.onDropped("unplaced-open");
      return;
    }
    if (this.state === "leaving") {
      // Brought round on its way out, from where the fade had got to.
      this.windowFade = fadeTo(this.windowFade.value, 1, fadeInMs());
      this.state = "open";
    }
    const current = this.layers[this.layers.length - 1];
    if (current) current.fade = fadeTo(current.fade.value, 0, fadeOutMs());
    this.layers = [
      ...(current ? [current] : []),
      this.layerOf(pending, measure, fadeTo(0, 1, fadeInMs())),
    ];
    this.pending = null;
    this.radius = measure.radius;
    this.frameMoving = true;
    const shownHeight = this.height.position;
    this.laidHeight = Math.max(shownHeight, measure.height);
    this.height = { ...this.height, target: measure.height };
    this.goTo(place);
    // The window answers the pointer: it springs to the new trigger in every
    // mode, and the content changes by its fade (SPEC_MOTION_LEVELS.md,
    // «Режимы», Н2).
    this.settleOn(pending.target);
  }

  private readArea(): HoverPreviewArea {
    return this.options.area?.() ?? hoverPreviewViewportArea();
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

  private layerOf(
    pending: { id: number; card: TCard },
    measure: HoverPreviewMeasure,
    fade: Fade,
  ): Layer<TCard> {
    return { id: pending.id, card: pending.card, fade, height: measure.height, mediaHeight: measure.mediaHeight };
  }

  /** After an appearance or a swap: what the surface and the frames see. */
  private settleOn(target: TTarget): void {
    this.shownTarget = target;
    this.host?.onSettled(target);
    this.run();
    this.emit();
    this.paint();
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
    if (this.state === "leaving" && fadeDone(this.windowFade)) {
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
      if (this.host) this.host.onTargetGone();
      else this.close();
      return true;
    }
    const place = this.place;
    if (next.left === place.left && next.top === place.top) return false;
    // Its own movement has no lag. Turning to the trigger's other side is a
    // change of place, so that part goes by the spring.
    if (next.side !== place.side) {
      this.y = { ...this.y, position: this.y.position + place.top - next.top, target: 0 };
    }
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
      left: hoverPreviewClampLeft(this.place.left + this.x.position, this.area),
      top: hoverPreviewClampTop(this.place.top + this.y.position, height, this.area),
    };
  }

  private paint(): void {
    const painter = this.painter;
    if (!painter || this.state === "closed") return;
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
          shown: this.state !== "closed",
          frameMoving: this.frameMoving,
          radius: this.radius,
          layers: roles,
        };
    for (const listener of this.listeners) listener();
  }
}
