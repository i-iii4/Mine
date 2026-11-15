// A tooltip that follows the pointer along its group (SPEC_MOTION_LEVELS.md,
// М3; user's decision of 15.11.2026: "the tooltip glides after the cursor,
// as the cards do"). The first tooltip of a group comes as before, after
// its delay. While it shows, the next button of the same group takes it
// over: the tooltip does not go and come again, it moves to the new button,
// its text and its width change to the new ones. The pointer leaving the
// group takes it away as before.
//
// Its reference is the one hover preview window (hoverPreviewWindow.ts, Н2):
// a floating surface that answers the pointer and moves from one trigger to
// the next on the stack's spring, its place in each axis and its size by
// springs of their own, a retarget keeping the place and the speed; the old
// content goes on Отклик's exit, the new comes on its enter. It answers the
// pointer, so it moves the same at every level (Р1). A key's focus stands
// its tooltip at once, as before (УД4).
//
// Each button keeps its own Radix tooltip, and with it the description its
// button gives assistive technology. The new button's tooltip lays itself
// out at its own place unseen; in the frame it shows, it draws its frame in
// pieces at the old one's place and size (the card window's frame,
// cardPeek.ts), the old text over it, and the old tooltip goes from the page
// in that same frame. From there the frame moves to its own place; only
// `transform` and `opacity` are written. At rest its own frame is back.
//
// A group is the buttons laid out in one container, on one line: a row of
// chrome buttons, the island of the image preview, a card's top buttons.
// Between two of them the pointer crosses a gap, a label or a separator; the
// tooltip stays while it does, for the preview's grace across a gap between
// two cards (`HOVER_INTENT.leaveGraceMs`, С7.4), and goes as before when
// the pointer leaves the container or the grace runs out.

import type { CSSProperties } from "react";
import { SPRING_RESPONSE_S, springSettleMs } from "./channelIcon";
import {
  CARD_PEEK_FRAME_STEP_MS,
  PEEK_FRAME_CORNERS,
  PEEK_FRAME_PIECES,
  clampUnit,
  lerp,
  peekBoxTransform,
  peekFrameCornerShapeStyle,
  peekFrameCut,
  peekFramePieceStyle,
  peekFrameTransforms,
  type PeekFrameCorner,
  type PeekFrameCut,
  type PeekFramePiece,
  type PeekRect,
} from "./cardPeek";
import { HOVER_INTENT } from "./hoverIntent";
import { stepHoverPreviewSpring, type HoverPreviewSpring } from "./hoverPreviewWindow";
import { roleMs } from "./motion";
import { lastInputIsKey } from "./motionInput";
import { onPointerLeftPage } from "./pointerLeftPage";

/** The spring from rest lands in this: the stack's spring, the preview
 *  window's (Н2). Past it with no retarget, the glide is over. */
export const TOOLTIP_GLIDE_SETTLE_MS = springSettleMs(SPRING_RESPONSE_S);

/** Radix's open state on the content; a tooltip's open state is
 *  `delayed-open` or `instant-open`. */
const STATE_ATTRIBUTE = "data-state";
const CLOSED_STATE = "closed";

/** A tooltip that took over from its neighbour: its own appearance does not
 *  run while it is open (global.css). */
export const TOOLTIP_HANDOFF_ATTRIBUTE = "data-tooltip-handoff";
/** A tooltip the pointer left for a gap of its group: its leaving waits. */
export const TOOLTIP_HOLD_ATTRIBUTE = "data-tooltip-hold";
/** A tooltip on its way: its own frame gives way to the frame in pieces. */
export const TOOLTIP_GLIDING_ATTRIBUTE = "data-tooltip-gliding";
/** The frame in pieces, while a tooltip glides. */
export const TOOLTIP_GLIDE_FRAME_ATTRIBUTE = "data-tooltip-glide-frame";
/** An outgoing text, while a tooltip glides. */
export const TOOLTIP_GLIDE_OUTGOING_ATTRIBUTE = "data-tooltip-glide-outgoing";

// ─── The group ──────────────────────────────────────────────────────────

interface Span {
  top: number;
  bottom: number;
}

function middle(span: Span): number {
  return (span.top + span.bottom) / 2;
}

/** Whether two spans lie on one line: each one's middle within the other. */
export function onOneLine(a: Span, b: Span): boolean {
  const ma = middle(a);
  const mb = middle(b);
  return ma >= b.top && ma <= b.bottom && mb >= a.top && mb <= a.bottom;
}

/** Whether the tooltips of two triggers are one group's: two buttons laid
 *  out in one container, on one line. A trigger is not its own neighbour. */
export function sameTooltipGroup(a: Element | null, b: Element | null): boolean {
  if (!a || !b || a === b) return false;
  const container = a.parentElement;
  if (!container || container !== b.parentElement) return false;
  return onOneLine(a.getBoundingClientRect(), b.getBoundingClientRect());
}

// ─── The motion ─────────────────────────────────────────────────────────

/** A box in the viewport. */
export interface GlideBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per second, as the springs keep it. */
export interface GlideVelocity {
  x: number;
  y: number;
  width: number;
  height: number;
}

const AT_REST: GlideVelocity = { x: 0, y: 0, width: 0, height: 0 };

interface Fade {
  value: number;
  from: number;
  to: number;
  ms: number;
  elapsed: number;
}

/** A fade of no length stands at its end from the start, as the preview
 *  window's (hoverPreviewWindow.ts). */
function fadeTo(from: number, to: number, ms: number): Fade {
  return { value: ms <= 0 || from === to ? to : from, from, to, ms, elapsed: 0 };
}

function stepFade(fade: Fade, dtMs: number): void {
  fade.elapsed += dtMs;
  fade.value = fade.ms <= 0 ? fade.to : lerp(fade.from, fade.to, clampUnit(fade.elapsed / fade.ms));
}

function fadeDone(fade: Fade): boolean {
  return fade.value === fade.to;
}

function springOf(position: number, velocity: number, target: number): HoverPreviewSpring {
  return { position, velocity, target };
}

/** The tooltip's content comes on Отклик's enter and the old one goes on its
 *  exit, the preview window's content (Н2). They answer the pointer: the
 *  same at every level. */
function enterMs(): number {
  return roleMs("response", "enter", { answers: true });
}

function exitMs(): number {
  return roleMs("response", "exit", { answers: true });
}

/**
 * The way of one glide, with no page: where the frame stands, how opaque the
 * surface, the new text and each old text are. The frame's place is kept as
 * the way left to the new place, in each axis, and its size as it is, each
 * by the stack's spring (`stepHoverPreviewSpring`): a new place keeps the
 * position and the speed, so a third button never jumps or breaks the speed.
 */
export class TooltipGlideMotion {
  private x: HoverPreviewSpring;
  private y: HoverPreviewSpring;
  private width: HoverPreviewSpring;
  private height: HoverPreviewSpring;
  private sinceStartMs = 0;
  readonly surface: Fade;
  readonly incoming: Fade;
  readonly outgoing: Fade[];

  constructor(
    readonly to: GlideBox,
    from: GlideBox,
    velocity: GlideVelocity,
    surfaceOpacity: number,
    outgoingOpacities: readonly number[],
  ) {
    this.x = springOf(from.x - to.x, velocity.x, 0);
    this.y = springOf(from.y - to.y, velocity.y, 0);
    this.width = springOf(from.width, velocity.width, to.width);
    this.height = springOf(from.height, velocity.height, to.height);
    this.surface = fadeTo(surfaceOpacity, 1, enterMs());
    this.incoming = fadeTo(0, 1, enterMs());
    this.outgoing = outgoingOpacities.map((opacity) => fadeTo(opacity, 0, exitMs()));
  }

  /** Where the frame stands now. */
  box(): GlideBox {
    return {
      x: this.to.x + this.x.position,
      y: this.to.y + this.y.position,
      width: this.width.position,
      height: this.height.position,
    };
  }

  velocity(): GlideVelocity {
    return { x: this.x.velocity, y: this.y.velocity, width: this.width.velocity, height: this.height.velocity };
  }

  step(dtMs: number): void {
    this.sinceStartMs += dtMs;
    if (this.sinceStartMs >= TOOLTIP_GLIDE_SETTLE_MS) {
      this.x = springOf(0, 0, 0);
      this.y = springOf(0, 0, 0);
      this.width = springOf(this.to.width, 0, this.to.width);
      this.height = springOf(this.to.height, 0, this.to.height);
    } else {
      this.x = stepHoverPreviewSpring(this.x, dtMs);
      this.y = stepHoverPreviewSpring(this.y, dtMs);
      this.width = stepHoverPreviewSpring(this.width, dtMs);
      this.height = stepHoverPreviewSpring(this.height, dtMs);
    }
    stepFade(this.surface, dtMs);
    stepFade(this.incoming, dtMs);
    for (const fade of this.outgoing) stepFade(fade, dtMs);
  }

  settled(): boolean {
    return this.sinceStartMs >= TOOLTIP_GLIDE_SETTLE_MS
      && fadeDone(this.surface)
      && fadeDone(this.incoming)
      && this.outgoing.every(fadeDone);
  }
}

// ─── The page ───────────────────────────────────────────────────────────

/** One tooltip's content while it is on the page. */
export interface TooltipGlideMember {
  /** `[data-slot="tooltip-content"]`: Radix's content, its frame. */
  content: HTMLElement;
  /** Inside the frame's line: clips the text while the frame moves. */
  clip: HTMLElement;
  /** The text, with its padding: what the tooltip says. */
  inner: HTMLElement;
  trigger(): Element | null;
}

interface Layer {
  element: HTMLElement;
  width: number;
  height: number;
}

interface Glide {
  motion: TooltipGlideMotion;
  /** The content's border box at its own place. */
  laid: GlideBox;
  border: { left: number; top: number; right: number; bottom: number };
  cut: PeekFrameCut;
  frame: HTMLElement;
  pieces: { element: HTMLElement; piece: PeekFramePiece }[];
  incoming: Layer;
  outgoing: Layer[];
}

interface Entry {
  member: TooltipGlideMember;
  observer: MutationObserver | null;
  open: boolean;
  /** When it opened, by the frames' clock. */
  openedAt: number;
  glide: Glide | null;
}

/** A pointer as the page last saw it. */
interface PointerPlace {
  x: number;
  y: number;
  buttons: number;
}

function inside(box: DOMRect, point: PointerPlace): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

function boxOf(element: Element): GlideBox {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Thousandths of a pixel. */
function rounded(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

function px(value: number): string {
  return `${rounded(value)}px`;
}

/** A piece's place as `peekFramePieceStyle` gives it, written on the element. */
function placePiece(element: HTMLElement, style: CSSProperties): void {
  for (const [property, value] of Object.entries(style)) {
    if (typeof value === "number") element.style.setProperty(kebab(property), px(value));
  }
}

function kebab(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function opacityText(value: number): string {
  return value >= 1 ? "" : String(rounded(value));
}

/** Radix lays its popper out off the page until it is placed. */
function placed(content: HTMLElement): boolean {
  const wrapper = content.parentElement;
  return wrapper !== null && !wrapper.style.transform.includes("-200%");
}

/**
 * The glides of one provider's tooltips. A tooltip's content attaches itself
 * while it is on the page; the coordinator hears its opening and closing on
 * Radix's `data-state`, and moves it from its neighbour when the neighbour
 * shows and both are one group's.
 */
export class TooltipGlide {
  private readonly entries = new Map<HTMLElement, Entry>();
  /** The tooltip on screen, open or on its way out. */
  private shown: Entry | null = null;
  /** The tooltip that takes over in the next frame. */
  private pending: Entry | null = null;
  private frame: number | null = null;
  private lastFrameAt = 0;
  private pointer: PointerPlace | null = null;
  private listening: Document | null = null;
  private stopFollowingExit: (() => void) | null = null;
  /** The tooltip whose leaving waits while the pointer crosses its group. */
  private held: { entry: Entry; timer: number } | null = null;

  /** The content came on the page. Returns its removal. */
  attach(member: TooltipGlideMember): () => void {
    const entry: Entry = { member, observer: null, open: false, openedAt: 0, glide: null };
    this.entries.set(member.content, entry);
    this.listen(member.content.ownerDocument);
    const view = member.content.ownerDocument.defaultView;
    if (view && typeof view.MutationObserver === "function") {
      entry.observer = new view.MutationObserver(() => this.stateChanged(entry));
      entry.observer.observe(member.content, { attributes: true, attributeFilter: [STATE_ATTRIBUTE] });
    }
    this.stateChanged(entry);
    return () => this.detach(entry);
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) this.detach(entry);
    this.unlisten();
  }

  // ─── The pointer ──────────────────────────────────────────────────────

  private listen(document: Document): void {
    if (this.listening) return;
    this.listening = document;
    document.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: true });
    document.addEventListener("pointerdown", this.onPress, { capture: true, passive: true });
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("scroll", this.onKey, { capture: true, passive: true });
    this.stopFollowingExit = onPointerLeftPage(this.onPointerLeftPage, document);
  }

  private unlisten(): void {
    const document = this.listening;
    if (!document) return;
    this.listening = null;
    document.removeEventListener("pointermove", this.onPointerMove, { capture: true });
    document.removeEventListener("pointerdown", this.onPress, { capture: true });
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("scroll", this.onKey, { capture: true });
    this.stopFollowingExit?.();
    this.stopFollowingExit = null;
    this.pointer = null;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY, buttons: event.buttons };
    const held = this.held;
    const container = held?.entry.member.trigger()?.parentElement;
    if (held && (!container || !inside(container.getBoundingClientRect(), this.pointer))) this.release();
  };

  private readonly onPress = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY, buttons: event.buttons };
    this.release();
  };

  private readonly onKey = (): void => {
    this.release();
  };

  /** The pointer left the page: no tooltip waits for it to reach a
   *  neighbour, and the one that waited goes (tooltip.tsx closes the one
   *  still open). */
  private readonly onPointerLeftPage = (): void => {
    this.pointer = null;
    this.release();
  };

  /**
   * Whether the leaving of a tooltip Radix just closed waits: it shows, the
   * pointer opened it, and the pointer has left its button for its group's
   * container, a gap, a label or a button with no tooltip, no button held.
   * A press, a key, Escape and a scroll close a tooltip with the pointer on
   * its button or with a key: its leaving runs at once.
   */
  private waitsOnLeave(entry: Entry): boolean {
    if (this.shown !== entry || lastInputIsKey()) return false;
    const trigger = entry.member.trigger();
    const container = trigger?.parentElement;
    const pointer = this.pointer;
    if (!trigger || !container || !pointer || pointer.buttons !== 0) return false;
    return inside(container.getBoundingClientRect(), pointer) && !inside(trigger.getBoundingClientRect(), pointer);
  }

  /** Its leaving waits, paused at its start: the tooltip shows whole. */
  private hold(entry: Entry): void {
    this.release();
    entry.member.content.setAttribute(TOOLTIP_HOLD_ATTRIBUTE, "");
    this.held = { entry, timer: window.setTimeout(() => this.release(), HOVER_INTENT.leaveGraceMs) };
  }

  /** The leaving that waited runs, as any tooltip's does. */
  private release(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    window.clearTimeout(held.timer);
    held.entry.member.content.removeAttribute(TOOLTIP_HOLD_ATTRIBUTE);
  }

  // ─── Opening and closing ──────────────────────────────────────────────

  private stateChanged(entry: Entry): void {
    const open = entry.member.content.getAttribute(STATE_ATTRIBUTE) !== CLOSED_STATE;
    if (open === entry.open) return;
    entry.open = open;
    if (open) this.opened(entry);
    else this.closed(entry);
  }

  private opened(entry: Entry): void {
    const { content } = entry.member;
    entry.openedAt = performance.now();
    if (this.pending && this.pending !== entry) this.pending = null;
    if (this.held?.entry === entry) {
      // Back on its button while its leaving waited: it stays as it shows,
      // with no second appearance.
      this.release();
      content.setAttribute(TOOLTIP_HANDOFF_ATTRIBUTE, "");
    }
    const from = this.shown;
    if (
      from
      && from !== entry
      && from.member.content.isConnected
      && !lastInputIsKey()
      && sameTooltipGroup(from.member.trigger(), entry.member.trigger())
    ) {
      // Laid out unseen at its own place until the frame it takes over in.
      content.setAttribute(TOOLTIP_HANDOFF_ATTRIBUTE, "");
      content.style.visibility = "hidden";
      this.pending = entry;
      this.run();
      return;
    }
    // Another group's tooltip: the one that waited leaves as before.
    this.release();
    content.style.visibility = "";
    this.shown = entry;
  }

  private closed(entry: Entry): void {
    // Its own leaving runs, or waits while the pointer crosses its group; a
    // glide on its way goes on under it.
    entry.member.content.removeAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
    if (this.pending === entry) this.pending = null;
    if (this.waitsOnLeave(entry)) this.hold(entry);
  }

  private detach(entry: Entry): void {
    entry.observer?.disconnect();
    if (this.held?.entry === entry) this.release();
    this.endGlide(entry);
    this.entries.delete(entry.member.content);
    if (this.shown === entry) this.shown = null;
    if (this.pending === entry) this.pending = null;
    if (this.entries.size === 0) {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.unlisten();
    }
  }

  // ─── The frames ───────────────────────────────────────────────────────

  private run(): void {
    if (this.frame !== null) return;
    this.lastFrameAt = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    // A frame held up longer slows the motion for that frame instead of
    // jumping it ahead, as the card's window and the preview window do.
    const dt = Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, now - this.lastFrameAt));
    this.lastFrameAt = now;
    for (const entry of this.entries.values()) {
      if (!entry.glide) continue;
      entry.glide.motion.step(dt);
      if (entry.glide.motion.settled()) this.endGlide(entry);
      else this.paint(entry);
    }
    const pending = this.pending;
    if (pending) this.takeOver(pending, now);
    const moving = this.pending !== null || [...this.entries.values()].some((entry) => entry.glide !== null);
    if (moving) this.frame = requestAnimationFrame(this.tick);
  };

  /** The frame `pending` shows in: it stands where its neighbour stands, and
   *  the neighbour goes from the page. */
  private takeOver(entry: Entry, now: number): void {
    const { content } = entry.member;
    if (!content.isConnected || !entry.open) {
      this.pending = null;
      return;
    }
    // Radix places it within a frame or two of its opening.
    if (!placed(content)) return;
    this.pending = null;
    const from = this.shown;
    const fromContent = from?.member.content;
    if (
      !from
      || from === entry
      || !fromContent?.isConnected
      || fromContent.style.visibility === "hidden"
      || fromContent.getAttribute("data-side") !== content.getAttribute("data-side")
    ) {
      // The neighbour is gone, or stands on the other side of its button:
      // this one comes as any next tooltip does, and the neighbour leaves.
      this.release();
      content.removeAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
      content.style.visibility = "";
      this.shown = entry;
      return;
    }

    // What the neighbour shows in its last frame.
    const fromGlide = from.glide;
    const box = fromGlide ? fromGlide.motion.box() : boxOf(fromContent);
    const velocity = fromGlide ? fromGlide.motion.velocity() : AT_REST;
    const surfaceOpacity = Number.parseFloat(getComputedStyle(fromContent).opacity);
    const old: { layer: Layer; opacity: number }[] = fromGlide
      ? [
          { layer: fromGlide.incoming, opacity: fromGlide.motion.incoming.value },
          ...fromGlide.outgoing.map((layer, index) => ({ layer, opacity: fromGlide.motion.outgoing[index]?.value ?? 0 })),
        ]
      : [{ layer: { element: from.member.inner, ...sizeOf(from.member.inner) }, opacity: 1 }];
    const visibleOld = old.filter(({ opacity }) => opacity > 0);

    const style = getComputedStyle(content);
    const border = {
      left: Number.parseFloat(style.borderLeftWidth) || 0,
      top: Number.parseFloat(style.borderTopWidth) || 0,
      right: Number.parseFloat(style.borderRightWidth) || 0,
      bottom: Number.parseFloat(style.borderBottomWidth) || 0,
    };
    const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
    const cut = peekFrameCut(radius, radius);
    const laid = boxOf(content);
    const frame = buildFrame(content.ownerDocument, laid, border, cut, radius, {
      fill: style.backgroundColor,
      line: style.borderTopColor,
      shadow: style.boxShadow,
    });

    const incoming: Layer = { element: entry.member.inner, ...sizeOf(entry.member.inner) };
    const outgoing = visibleOld.map(({ layer }) => cloneLayer(layer));
    const motion = new TooltipGlideMotion(
      laid,
      box,
      velocity,
      Number.isNaN(surfaceOpacity) ? 1 : surfaceOpacity,
      visibleOld.map(({ opacity }) => opacity),
    );
    // From a neighbour at rest the motion runs from the opening, so this
    // frame already moves; a gliding neighbour has stepped to this frame.
    if (!fromGlide) motion.step(Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, now - entry.openedAt)));

    content.prepend(frame.element);
    for (const layer of outgoing) entry.member.clip.append(layer.element);
    content.setAttribute(TOOLTIP_GLIDING_ATTRIBUTE, "");
    entry.glide = { motion, laid, border, cut, frame: frame.element, pieces: frame.pieces, incoming, outgoing };
    this.paint(entry);
    content.style.visibility = "";

    // The neighbour leaves the page in this same frame, its leaving unseen.
    this.endGlide(from);
    fromContent.style.visibility = "hidden";
    if (this.held?.entry === from) this.release();
    this.shown = entry;
  }

  private paint(entry: Entry): void {
    const glide = entry.glide;
    if (!glide) return;
    const { content, clip } = entry.member;
    const { laid, border, motion } = glide;
    const box = motion.box();
    const shown: PeekRect = { x: box.x - laid.x, y: box.y - laid.y, width: box.width, height: box.height };
    const transforms = peekFrameTransforms({ width: laid.width, height: laid.height }, shown, glide.cut);
    for (const { element, piece } of glide.pieces) element.style.transform = transforms[piece];

    // The text rides with the frame's middle, unscaled, clipped inside its line.
    const clipWidth = Math.max(1, laid.width - border.left - border.right);
    const clipHeight = Math.max(1, laid.height - border.top - border.bottom);
    const shownClip: PeekRect = {
      x: shown.x,
      y: shown.y,
      width: Math.max(1, shown.width - border.left - border.right),
      height: Math.max(1, shown.height - border.top - border.bottom),
    };
    const scaleX = shownClip.width / clipWidth;
    const scaleY = shownClip.height / clipHeight;
    clip.style.transformOrigin = "0 0";
    clip.style.transform = peekBoxTransform({ x: 0, y: 0, width: clipWidth, height: clipHeight }, shownClip);
    const ride = (layer: Layer, opacity: number) => {
      const tx = (shownClip.width - layer.width) / 2 / scaleX;
      const ty = (shownClip.height - layer.height) / 2 / scaleY;
      layer.element.style.transformOrigin = "0 0";
      layer.element.style.transform = `translate(${px(tx)}, ${px(ty)}) scale(${rounded(1 / scaleX)}, ${rounded(1 / scaleY)})`;
      layer.element.style.opacity = opacityText(opacity);
    };
    ride(glide.incoming, motion.incoming.value);
    glide.outgoing.forEach((layer, index) => ride(layer, motion.outgoing[index]?.value ?? 0));
    content.style.opacity = opacityText(motion.surface.value);
  }

  /** Back on its own frame and text, nothing of the glide left. */
  private endGlide(entry: Entry): void {
    const glide = entry.glide;
    if (!glide) return;
    entry.glide = null;
    const { content, clip, inner } = entry.member;
    glide.frame.remove();
    for (const layer of glide.outgoing) layer.element.remove();
    content.removeAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    content.style.opacity = "";
    for (const element of [clip, inner]) {
      element.style.transform = "";
      element.style.transformOrigin = "";
      element.style.opacity = "";
    }
  }
}

/** An element's own size, whatever transform an animation gives it: the
 *  used width and height (border boxes, as the page lays every box out). */
function sizeOf(element: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(element);
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function isCorner(piece: PeekFramePiece): piece is PeekFrameCorner {
  return PEEK_FRAME_CORNERS.some((corner) => corner === piece);
}

/** An old text over the new frame, as it stood in the old one. */
function cloneLayer(layer: Layer): Layer {
  const copy = layer.element.cloneNode(true);
  const element = copy instanceof HTMLElement ? copy : layer.element.ownerDocument.createElement("span");
  element.removeAttribute("data-tooltip-text");
  element.setAttribute(TOOLTIP_GLIDE_OUTGOING_ATTRIBUTE, "");
  element.setAttribute("aria-hidden", "true");
  element.style.position = "absolute";
  element.style.left = "0px";
  element.style.top = "0px";
  element.style.margin = "0px";
  element.style.boxSizing = "border-box";
  element.style.width = px(layer.width);
  element.style.height = px(layer.height);
  element.style.pointerEvents = "none";
  return { element, width: layer.width, height: layer.height };
}

/** The tooltip's frame in pieces, laid at its own border box, the card
 *  window's frame (cardPeek.ts): the bands and lines scale only along
 *  themselves and the corners only move, so its line and its corners are
 *  never stretched. Its colours and shadow are the tooltip's own. */
function buildFrame(
  document: Document,
  laid: GlideBox,
  border: { left: number; top: number },
  cut: PeekFrameCut,
  radius: number,
  colors: { fill: string; line: string; shadow: string },
): { element: HTMLElement; pieces: { element: HTMLElement; piece: PeekFramePiece }[] } {
  const frame = document.createElement("div");
  frame.setAttribute(TOOLTIP_GLIDE_FRAME_ATTRIBUTE, "");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "absolute",
    left: px(-border.left),
    top: px(-border.top),
    width: px(laid.width),
    height: px(laid.height),
    pointerEvents: "none",
  });
  const pieces: { element: HTMLElement; piece: PeekFramePiece }[] = [];
  for (const piece of PEEK_FRAME_PIECES) {
    const element = document.createElement("div");
    element.setAttribute("data-tooltip-glide-piece", piece);
    element.style.position = "absolute";
    element.style.transformOrigin = "0 0";
    placePiece(element, peekFramePieceStyle(piece, cut));
    if (piece === "shadow") {
      element.style.boxShadow = colors.shadow;
      element.style.borderRadius = px(radius);
    } else if (piece === "bandAcross" || piece === "bandDown") {
      element.style.backgroundColor = colors.fill;
    } else if (piece.startsWith("line")) {
      element.style.backgroundColor = colors.line;
    } else if (isCorner(piece)) {
      element.style.overflow = "hidden";
      const shape = document.createElement("div");
      shape.style.position = "absolute";
      shape.style.boxSizing = "border-box";
      placePiece(shape, peekFrameCornerShapeStyle(piece, cut, radius));
      shape.style.borderRadius = px(radius);
      shape.style.backgroundColor = colors.fill;
      shape.style.border = `${px(border.top)} solid ${colors.line}`;
      element.append(shape);
    }
    frame.append(element);
    pieces.push({ element, piece });
  }
  return { element: frame, pieces };
}
