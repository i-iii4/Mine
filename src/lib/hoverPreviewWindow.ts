// The one hover preview window of the sidebar, the open card's panel and the
// graph (SPEC_CARD_STATES.md, С7.11). It lives while the pointer goes over the
// list or the graph. Only a new trigger in the attending mode changes anything,
// and then its card and its place change together, the place by one motion of a
// spring. The pointer moving inside a trigger moves nothing; a trigger that moves
// on its own, a node of the graph, takes the window with it every frame, with no
// lag. All three surfaces get the same timing and the same gating from here.
//
// This module is the pointer's part (SPEC_OUTSIDE_WINDOW.md, НО6): which
// trigger is under the pointer, when the window opens, which card it holds and
// where each trigger has it stand. The window itself, its layers, springs and
// fades, is `HoverPreviewPresenter` (hoverPreviewPresenter.ts), which this
// drives through `HoverPreviewStage`. The component (HoverPreviewWindow.tsx)
// renders the cards, measures them once at a change and writes what `paint`
// gives it. A showing with no room beside its panel inside the app window
// goes to the outside window (SPEC_OUTSIDE_WINDOW.md, ПН2): the same calls
// drive `OutsidePreviewStage` (outsidePreviewSource.ts) instead.

import { FLOATING_LAYER_EDGE_PX } from "./floatingLayer";
import { HOVER_INTENT } from "./hoverIntent";
import type { HoverPreviewOpener } from "./hoverPreviewTiming";
import { OutsidePreviewStage, outsideWindowAnswers, type OutsidePreviewPlan, type OutsideStageEnd } from "./outsidePreviewSource";
import {
  HOVER_PREVIEW_WINDOW_WIDTH_PX,
  HoverPreviewPresenter,
  hoverPreviewClampTop,
  type HoverPreviewArea,
  type HoverPreviewDrawn,
  type HoverPreviewDropReason,
  type HoverPreviewMeasure,
  type HoverPreviewPlacer,
  type HoverPreviewStage,
  type HoverPreviewStageHost,
  type HoverPreviewTarget,
  type HoverPreviewWindowPaint,
  type HoverPreviewWindowView,
} from "./hoverPreviewPresenter";

export {
  HOVER_PREVIEW_WINDOW_SETTLE_MS,
  HOVER_PREVIEW_WINDOW_WIDTH_PX,
  hoverPreviewCoverScale,
  stepHoverPreviewSpring,
} from "./hoverPreviewPresenter";
export type {
  HoverPreviewLayerView,
  HoverPreviewMeasure,
  HoverPreviewPlace,
  HoverPreviewPlacer,
  HoverPreviewSpring,
  HoverPreviewTarget,
  HoverPreviewWindowPaint,
  HoverPreviewWindowView,
} from "./hoverPreviewPresenter";

/** Between the window and the panel it stands beside. */
export const HOVER_PREVIEW_WINDOW_GAP_PX = 8;

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

/** The top of a frame `height` tall centred on `center`, kept off the edges. */
export function hoverPreviewWindowTop(center: number, height: number, viewportHeight: number): number {
  return hoverPreviewClampTop(center - height / 2, height, {
    top: FLOATING_LAYER_EDGE_PX,
    bottom: viewportHeight - FLOATING_LAYER_EDGE_PX,
  });
}

/** With no room beside the panel: under the row, or over it. */
export function hoverPreviewWindowRowTop(row: VerticalSpan, height: number, viewportHeight: number): number {
  const below = row.bottom + HOVER_PREVIEW_WINDOW_GAP_PX;
  return below + height <= viewportHeight - FLOATING_LAYER_EDGE_PX
    ? below
    : Math.max(FLOATING_LAYER_EDGE_PX, row.top - HOVER_PREVIEW_WINDOW_GAP_PX - height);
}

// ─── The window ─────────────────────────────────────────────────────────

/** A trigger on the page: the window stands by its box. */
export interface HoverPreviewElementTarget extends HoverPreviewTarget {
  /** Read once, when its card comes on. */
  element: Element;
}

/** A showing of a surface beside `panel` goes outside when neither side of
 *  the panel has room inside the app window (ПН1, ПН2): the plan of that
 *  showing, or `null` when it stays inside. */
export function hoverPreviewOutsideBesidePanel<TTarget extends HoverPreviewElementTarget, TCard>(options: {
  panel: () => DOMRect | null;
  side: HoverPreviewSide;
  look: () => OutsidePreviewPlan<TTarget, TCard>["look"] | null;
  content: OutsidePreviewPlan<TTarget, TCard>["content"];
}): (target: TTarget) => OutsidePreviewPlan<TTarget, TCard> | null {
  return () => {
    if (!outsideWindowAnswers()) return null;
    const panel = options.panel();
    if (!panel || hoverPreviewWindowLeft(panel, window.innerWidth, options.side) !== null) return null;
    const look = options.look();
    if (!look) return null;
    return {
      panel: { x: panel.left, y: panel.top, width: panel.width, height: panel.height },
      side: options.side,
      look,
      trigger: (target) => {
        if (!target.element.isConnected) return null;
        const box = target.element.getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height };
      },
      content: options.content,
    };
  };
}

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
  /** Where the window may stand; the app window's viewport when not given. */
  area?: () => HoverPreviewArea;
  /** The plan of a showing outside the app window for its first target, or
   *  `null` when it stays inside (SPEC_OUTSIDE_WINDOW.md, ПН1, ПН2). */
  outside?(target: TTarget): OutsidePreviewPlan<TTarget, TCard> | null;
  /** The card now shown, or `null`: a row may mark its own. */
  onShown?(target: TTarget | null): void;
}

export class HoverPreviewWindow<TTarget extends HoverPreviewTarget, TCard> implements HoverPreviewDrawn<TCard> {
  private readonly options: HoverPreviewWindowOptions<TTarget, TCard>;
  /** The window in this page; the component draws it. */
  private readonly presenter: HoverPreviewPresenter<TTarget, TCard>;
  /** The window this drives now: this page's, or the outside window's for
   *  a showing that goes there. */
  private stage: HoverPreviewStage<TTarget, TCard>;

  private frozen = false;
  private underPointer: TTarget | null = null;
  /** The target the opener is timing, while the window is not open. */
  private requestKey: string | null = null;
  private idleTimer: number | null = null;
  private wantedKey: string | null = null;
  private readToken = 0;

  constructor(options: HoverPreviewWindowOptions<TTarget, TCard>) {
    this.options = options;
    this.presenter = new HoverPreviewPresenter<TTarget, TCard>({
      place: options.place,
      tracksTarget: options.tracksTarget,
      area: options.area,
    });
    this.presenter.setHost(this.host);
    this.stage = this.presenter;
  }

  // ─── For the component ────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => this.presenter.subscribe(listener);

  getView = (): HoverPreviewWindowView<TCard> | null => this.presenter.getView();

  setPainter(painter: ((paint: HoverPreviewWindowPaint) => void) | null): void {
    this.presenter.setPainter(painter);
  }

  /** The component rendered a new view: its new elements take the geometry. */
  repaint(): void {
    this.presenter.repaint();
  }

  /** The pending card is laid out and decoded, or out of time. */
  prepared(id: number, measure: HoverPreviewMeasure): void {
    this.presenter.prepared(id, measure);
  }

  // ─── For the surface ──────────────────────────────────────────────────

  /** The pointer's own step, on `target` or on no row. */
  pointer(target: TTarget | null): void {
    if (this.frozen) return;
    this.underPointer = target;
    this.stage.pointerOn?.(target?.key ?? null);
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
    this.stage.pointerOn?.(null);
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
    this.stage.close();
  }

  /** The trigger left the page: what belonged to it goes (С7.10). */
  forget(key: string): void {
    if (this.stage.shownKey() === key) {
      this.dismiss();
      return;
    }
    if (this.requestKey === key || this.stage.pendingKey() === key) {
      this.options.opener.cancel();
      this.requestKey = null;
      this.dropPending();
      this.wantedKey = this.stage.shownKey();
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
    this.wantedKey = this.stage.shownKey();
  }

  /** Drops a request on the way; a window on screen stays. */
  cancelPending(): void {
    this.options.opener.cancel();
    this.requestKey = null;
    this.dropPending();
    this.wantedKey = this.stage.shownKey();
  }

  dispose(): void {
    this.dismiss();
    this.presenter.dispose();
  }

  // ─── What the window tells ────────────────────────────────────────────

  private readonly host: HoverPreviewStageHost<TTarget> = {
    stillWanted: (key) => this.underPointer?.key === key,
    onSettled: (target) => {
      this.requestKey = null;
      this.wantedKey = target.key;
      this.options.onShown?.(target);
    },
    onHidden: () => {
      this.options.onShown?.(null);
    },
    onDropped: (reason: HoverPreviewDropReason) => {
      this.readToken += 1;
      if (reason === "unplaced-closed") {
        this.requestKey = null;
        this.wantedKey = null;
        return;
      }
      this.wantedKey = this.stage.shownKey();
      if (reason === "left") {
        this.requestKey = null;
        this.sync();
      }
    },
    onTargetGone: () => this.dismiss(),
  };

  // ─── What the pointer asks for ────────────────────────────────────────

  private sync(): void {
    const target = this.underPointer;
    if (this.stage.phase() !== "open") {
      this.clearIdle();
      if (!target) {
        if (this.requestKey !== null || this.stage.pendingKey() !== null) {
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
    if (target.key === this.stage.shownKey()) {
      this.dropPending();
      this.wantedKey = target.key;
      return;
    }
    this.want(target);
  }

  private want(target: TTarget): void {
    if (this.stage.phase() === "leaving" && this.stage.fadingKey() === target.key) {
      this.stage.bringBack(target);
      return;
    }
    if (this.wantedKey === target.key) return;
    this.wantedKey = target.key;
    this.dropPending();
    const token = ++this.readToken;
    const gaveNothing = () => {
      if (token !== this.readToken) return;
      this.wantedKey = this.stage.shownKey();
    };
    void this.options.readCard(target.slug).then((card) => {
      if (token !== this.readToken) return;
      if (!card) {
        gaveNothing();
        return;
      }
      this.chooseStage(target);
      this.stage.offer(target, card);
    }, gaveNothing);
  }

  /** A showing about to begin goes outside when its surface plans it so
   *  (ПН4: one decision a showing, kept until the window closes). */
  private chooseStage(target: TTarget): void {
    if (this.stage !== this.presenter || this.presenter.phase() !== "closed" || this.presenter.pendingKey() !== null) return;
    const plan = this.options.outside?.(target) ?? null;
    if (!plan) return;
    const stage: OutsidePreviewStage<TTarget, TCard> = new OutsidePreviewStage<TTarget, TCard>({
      plan,
      host: this.host,
      onEnd: (end, offered) => this.outsideEnded(stage, end, offered),
    });
    this.stage = stage;
  }

  /** The outside window handed its showing back. */
  private outsideEnded(
    stage: HoverPreviewStage<TTarget, TCard>,
    end: OutsideStageEnd,
    offered: { target: TTarget; card: TCard } | null,
  ): void {
    if (this.stage !== stage) return;
    this.stage = this.presenter;
    switch (end.kind) {
      case "closed":
        return;
      case "refused":
        // The showing stays inside, as before the decision (НО9).
        if (offered && this.underPointer?.key === offered.target.key) this.presenter.offer(offered.target, offered.card);
        else this.wantedKey = null;
        return;
      case "ended":
        if (end.reason !== "unresponsive") {
          this.dismiss();
          return;
        }
        // Drawn inside from now on: the outside window waits until its page
        // listens again (НО9).
        this.requestKey = null;
        this.wantedKey = null;
        if (this.underPointer && !this.frozen) this.want(this.underPointer);
    }
  }

  /** A read on the way is forgotten, a card laid out unseen goes. */
  private dropPending(): void {
    this.readToken += 1;
    this.stage.dropPending();
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

  private fadeOut(): void {
    this.clearIdle();
    this.options.opener.hide();
    this.requestKey = null;
    this.wantedKey = null;
    this.readToken += 1;
    this.stage.fadeOut();
  }
}
