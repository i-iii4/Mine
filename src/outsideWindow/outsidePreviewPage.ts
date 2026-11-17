// What the outside window's page does with the hover preview window
// (SPEC_OUTSIDE_WINDOW.md, НО6, НО7). The source page's pointer decides what
// the window shows and when; here the same window code it uses inside
// (`HoverPreviewPresenter`) hears those calls as numbered messages, in their
// order, and tells back what the window did. So the window moves outside as
// it moves inside (ПН7).

import { publishCollectionOrder } from "@/lib/cardCollections";
import { reloadFeedDisplay } from "@/lib/feedDisplay";
import {
  HoverPreviewPresenter,
  type HoverPreviewDropReason,
  type HoverPreviewStageHost,
  type HoverPreviewTarget,
} from "@/lib/hoverPreviewPresenter";
import { MessageRow } from "@/lib/menuPanelProtocol";
import type {
  CardStack,
  OutsideLook,
  OutsidePageMessage,
  OutsidePageReport,
  PageArea,
  PreviewContent,
  PreviewEvent,
  PreviewStep,
  ScreenPoint,
  ScreenRect,
} from "@/types";

/** A trigger on this page: the source's, moved here by the backend. */
export interface OutsidePreviewTarget extends HoverPreviewTarget {
  trigger: ScreenRect;
}

/** One showing: the window, where it may stand, what its cards need. */
export interface OutsidePreviewSession {
  id: number;
  area: PageArea;
  look: OutsideLook;
  presenter: HoverPreviewPresenter<OutsidePreviewTarget, PreviewContent>;
}

/** A dragged card (SPEC_OUTSIDE_WINDOW.md, ПК1): its front card's top left on
 *  the page and what it is drawn of. */
export interface OutsideDrag {
  id: number;
  at: ScreenPoint;
  stack: CardStack;
}

interface Running extends OutsidePreviewSession {
  steps: MessageRow<PreviewStep>;
  /** The trigger the source's pointer is on: a card ready for another is a flash. */
  wanted: string | null;
  reports: number;
  /** The number of the last step taken. */
  applied: number;
  painted: boolean;
}

/** Beside the panel, at the column's left; its centre on the trigger's. */
function placeIn(area: PageArea) {
  return (target: OutsidePreviewTarget, height: number) => ({
    left: area.left,
    top: target.trigger.y + target.trigger.height / 2 - height / 2,
  });
}

function targetOf(key: string, trigger: ScreenRect): OutsidePreviewTarget {
  return { key, slug: key, trigger };
}

/** Run `run` after the next two frames: the page has drawn by then. */
function afterTwoFrames(run: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(run));
}

export class OutsidePreviewPage {
  private readonly tell: (report: OutsidePageReport) => void;
  private readonly listeners = new Set<() => void>();
  private running: Running | null = null;
  private dragging: OutsideDrag | null = null;

  constructor(tell: (report: OutsidePageReport) => void) {
    this.tell = tell;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The showing on this page now, or none. */
  current = (): OutsidePreviewSession | null => this.running;

  /** The dragged card on this page now, or none. */
  drag = (): OutsideDrag | null => this.dragging;

  /** The dragged card is drawn, its pictures in or out of time (ПК2). */
  dragDrawn(id: number): void {
    if (this.dragging?.id === id) this.tell({ kind: "drag_shown", session: id });
  }

  /** A message of the backend. */
  hear(message: OutsidePageMessage): void {
    switch (message.kind) {
      case "preview":
        this.begin(message.session, message.area, message.look);
        return;
      case "preview_step": {
        const running = this.running;
        if (running?.id !== message.session) return;
        for (const step of running.steps.take(message.number, message.step)) {
          running.applied += 1;
          this.apply(running, step);
        }
        return;
      }
      case "drag":
        this.drop();
        this.dragging = { id: message.session, at: message.at, stack: message.stack };
        publishCollectionOrder(message.stack.look.collection_order);
        reloadFeedDisplay();
        this.emit();
        return;
      case "drag_end":
        if (this.dragging?.id !== message.session) return;
        this.dragging = null;
        this.emit();
        return;
      case "end":
        if (this.running?.id !== message.session) return;
        this.drop();
        // The page drew nothing in time: it says it listens again, which
        // proves it does (SPEC_OUTSIDE_WINDOW.md, НО9).
        if (message.reason === "unresponsive") afterTwoFrames(() => this.tell({ kind: "ready" }));
    }
  }

  dispose(): void {
    this.drop();
  }

  private begin(id: number, area: PageArea, look: OutsideLook): void {
    this.drop();
    // The card is drawn as the source's: its order of collections, the
    // feed's look from storage (SPEC_CARD_STATES.md, С10.1).
    publishCollectionOrder(look.collection_order);
    reloadFeedDisplay();
    const presenter = new HoverPreviewPresenter<OutsidePreviewTarget, PreviewContent>({
      place: placeIn(area),
      area: () => area,
    });
    const running: Running = { id, area, look, presenter, steps: new MessageRow<PreviewStep>(), wanted: null, reports: 0, applied: 0, painted: false };
    presenter.setHost(this.hostOf(running));
    this.running = running;
    this.emit();
  }

  private drop(): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    running.presenter.setHost(null);
    running.presenter.dispose();
    this.emit();
  }

  private apply(running: Running, step: PreviewStep): void {
    const { presenter } = running;
    switch (step.kind) {
      case "offer":
        running.wanted = step.key;
        presenter.offer(targetOf(step.key, step.trigger), step.content);
        this.report(running, null);
        return;
      case "wanted":
        running.wanted = step.key;
        return;
      case "drop_pending":
        presenter.dropPending();
        this.report(running, null);
        return;
      case "bring_back":
        running.wanted = step.key;
        presenter.bringBack(targetOf(step.key, step.trigger));
        return;
      case "fade_out":
        running.wanted = null;
        presenter.fadeOut();
        this.report(running, null);
        return;
      case "close":
        running.wanted = null;
        presenter.close();
    }
  }

  private hostOf(running: Running): HoverPreviewStageHost<OutsidePreviewTarget> {
    return {
      stillWanted: (key) => running.wanted === key,
      onSettled: (target) => {
        this.report(running, { kind: "settled", key: target.key });
        if (running.painted) return;
        running.painted = true;
        requestAnimationFrame(() => {
          if (this.running === running) this.tell({ kind: "first_frame", session: running.id });
        });
      },
      onHidden: () => this.report(running, { kind: "hidden" }),
      onDropped: (reason: HoverPreviewDropReason) => this.report(running, { kind: "dropped", reason }),
      // A trigger outside never moves on its own: nothing is tracked here.
      onTargetGone: () => running.presenter.close(),
      onClosed: () => this.report(running, { kind: "closed" }),
    };
  }

  private report(running: Running, event: PreviewEvent | null): void {
    if (this.running !== running) return;
    running.reports += 1;
    const { presenter } = running;
    this.tell({
      kind: "preview",
      session: running.id,
      number: running.reports,
      report: {
        applied: running.applied,
        phase: presenter.phase(),
        shown_key: presenter.shownKey(),
        fading_key: presenter.fadingKey(),
        pending_key: presenter.pendingKey(),
        event,
      },
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
