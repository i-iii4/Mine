// A source page's side of a preview shown outside its app window
// (SPEC_OUTSIDE_WINDOW.md, ПН2, НО6, НО7). The pointer's part
// (`HoverPreviewWindow`) drives a window through `HoverPreviewStage`; for a
// showing with no room beside its panel inside the app window, the stage is
// `OutsidePreviewStage`: it opens the showing in the outside window, sends what
// the pointer asks as numbered steps, and holds the window's state as the
// outside window's page reports it, in the order of the reports.
//
// The state a call changes at once in a window of this page (a card offered,
// a fade begun) changes here at once too; a report replaces it only once it
// has taken every step sent, so a report on its way never undoes a later step.

import type { CollectionPreviewContent } from "@/components/CollectionHoverPreview";
import { lightBlockFromIndexed } from "./blockDrag";
import { currentCollectionOrder } from "./cardCollections";
import { listenPage } from "./pageEvents";
import { MessageRow } from "./menuPanelProtocol";
import {
  OUTSIDE_TO_SOURCE_EVENT,
  openPreviewOutside,
  prepareOutsideWindow,
  sendPreviewStep,
} from "./outsideWindowCommands";
import type {
  HoverPreviewPhase,
  HoverPreviewStage,
  HoverPreviewStageHost,
  HoverPreviewTarget,
} from "./hoverPreviewPresenter";
import type {
  IndexedBlock,
  LightBlock,
  OutsideCloseReason,
  OutsideLook,
  OutsideSourceMessage,
  PreviewContent,
  PreviewOpenRequest,
  PreviewReport,
  PreviewSide,
  PreviewStep,
  PreviewStepRequest,
  ScreenRect,
} from "@/types";

const LOG = "Outside window";

function logFailure(what: string, error: unknown): void {
  console.error(`${LOG}: ${what}:`, error);
}

/** This page's load. A page loaded anew counts its showings from one again,
 *  and the backend tells the two counts apart by this. */
const PAGE = crypto.randomUUID();

let lastShow = 0;
let following = false;
/** The backend answered this page's preparation: it has an outside window
 *  to ask. A page with no backend (a dev route) keeps every preview inside. */
let answered = false;
const showings = new Map<number, (message: OutsideSourceMessage) => void>();

/** What the backend says of this page's showings. */
export function hearOutsideWindow(message: OutsideSourceMessage): void {
  showings.get(message.show)?.(message);
}

/**
 * A page's entry: has the outside window made, and hears what the backend
 * says of this page's showings. A second call does nothing.
 */
export function followOutsideWindow(): void {
  if (following) return;
  following = true;
  void listenPage<OutsideSourceMessage>(OUTSIDE_TO_SOURCE_EVENT, (event) => hearOutsideWindow(event.payload)).catch(() => {
    // Outside a Tauri page there is no outside window: every preview stays
    // in the page.
  });
  void prepareOutsideWindow(PAGE).then(
    () => {
      answered = true;
    },
    (error: unknown) => logFailure("the window was not made", error),
  );
}

/** Whether a showing may be asked of the outside window: the backend
 *  answered. Whether it takes the showing, it says when asked (НО9). */
export function outsideWindowAnswers(): boolean {
  return answered;
}

/** What a card outside needs that only this page knows: its space and the
 *  sidebar's order of collections, as the card here is drawn with. */
export function outsideLook(vaultPath: string, thumbsRootPath: string | null): OutsideLook {
  return { vault_path: vaultPath, thumbs_root_path: thumbsRootPath, collection_order: [...currentCollectionOrder()] };
}

/** A card as the outside window draws it: the feed's record of it. */
export function outsideCardContent(block: LightBlock | IndexedBlock, thumbVersion: number | null = null): PreviewContent {
  return { kind: "card", block: "related_notes" in block ? lightBlockFromIndexed(block) : block, thumb_version: thumbVersion };
}

/** A collection's window as the outside window draws it (С7.12). */
export function outsideCollectionContent(content: CollectionPreviewContent): PreviewContent {
  return {
    kind: "collection",
    collection: {
      row_key: content.rowKey,
      name: content.name,
      count: content.count,
      cards: content.cards.map((card) => ({ slug: card.slug ?? null, url: card.url, text: card.text, has_thumb: card.hasThumb })),
      placeholders: content.placeholders,
    },
  };
}

/** What a showing outside needs of its surface, read when it opens. */
export interface OutsidePreviewPlan<TTarget, TCard> {
  /** The panel the window stands beside, in this page's points. */
  panel: ScreenRect;
  side: PreviewSide;
  look: OutsideLook;
  /** A trigger's box in this page's points, or `null` when it is gone. */
  trigger(target: TTarget): ScreenRect | null;
  /** A card as the outside window draws it, or `null` when it cannot. */
  content(card: TCard): PreviewContent | null;
}

/** The backend's commands a stage uses; a test gives its own. */
export interface OutsidePreviewCommands {
  open(request: PreviewOpenRequest): Promise<void>;
  step(request: PreviewStepRequest): Promise<void>;
}

const BACKEND: OutsidePreviewCommands = { open: openPreviewOutside, step: sendPreviewStep };

/** Why a stage handed its showing back. */
export type OutsideStageEnd =
  /** Its window was on screen and closed: the showing is over. */
  | { kind: "closed" }
  /** The backend refused the showing: `target` and `card` go inside. */
  | { kind: "refused" }
  /** The backend ended it. */
  | { kind: "ended"; reason: OutsideCloseReason };

export interface OutsidePreviewStageOptions<TTarget extends HoverPreviewTarget, TCard> {
  plan: OutsidePreviewPlan<TTarget, TCard>;
  host: HoverPreviewStageHost<TTarget>;
  /** The showing is over or was refused; a refused card is `offered`. */
  onEnd(end: OutsideStageEnd, offered: { target: TTarget; card: TCard } | null): void;
  commands?: OutsidePreviewCommands;
}

export class OutsidePreviewStage<TTarget extends HoverPreviewTarget, TCard> implements HoverPreviewStage<TTarget, TCard> {
  private readonly options: OutsidePreviewStageOptions<TTarget, TCard>;
  private readonly commands: OutsidePreviewCommands;
  private readonly show = ++lastShow;
  private readonly reports = new MessageRow<OutsideSourceMessage>();
  private readonly targets = new Map<string, TTarget>();
  /** The opening was asked for; `opened` once the backend took it. */
  private opening = false;
  private opened = false;
  /** The card offered last and not dropped since: a refusal hands it inside. */
  private lastOffer: { target: TTarget; card: TCard } | null = null;
  private ended = false;
  /** Steps waiting for the backend's answer to the opening. */
  private held: PreviewStep[] = [];
  private sent = 0;
  private pointerKey: string | null = null;

  private state: { phase: HoverPreviewPhase; shown: string | null; fading: string | null; pending: string | null } = {
    phase: "closed",
    shown: null,
    fading: null,
    pending: null,
  };

  constructor(options: OutsidePreviewStageOptions<TTarget, TCard>) {
    this.options = options;
    this.commands = options.commands ?? BACKEND;
    showings.set(this.show, (message) => this.hear(message));
  }

  /** Whether the showing is still this stage's. */
  live(): boolean {
    return !this.ended;
  }

  phase(): HoverPreviewPhase {
    return this.state.phase;
  }

  shownKey(): string | null {
    return this.state.shown;
  }

  fadingKey(): string | null {
    return this.state.fading;
  }

  pendingKey(): string | null {
    return this.state.pending;
  }

  offer(target: TTarget, card: TCard): void {
    const content = this.options.plan.content(card);
    const trigger = this.options.plan.trigger(target);
    if (this.ended || content === null || trigger === null) {
      this.refuse({ target, card });
      return;
    }
    this.targets.set(target.key, target);
    this.state.pending = target.key;
    this.pointerKey = target.key;
    this.lastOffer = { target, card };
    if (!this.opening) this.open(trigger);
    this.send({ kind: "offer", key: target.key, trigger, content });
  }

  dropPending(): void {
    this.lastOffer = null;
    if (this.state.pending === null) return;
    this.state.pending = null;
    this.send({ kind: "drop_pending" });
  }

  bringBack(target: TTarget): void {
    const trigger = this.options.plan.trigger(target);
    if (trigger === null) return;
    this.targets.set(target.key, target);
    this.state = { phase: "open", shown: target.key, fading: null, pending: this.state.pending };
    this.pointerKey = target.key;
    this.send({ kind: "bring_back", key: target.key, trigger });
  }

  fadeOut(): void {
    this.lastOffer = null;
    this.state.pending = null;
    if (this.state.phase === "open") this.state = { phase: "leaving", shown: null, fading: this.state.shown, pending: null };
    this.send({ kind: "fade_out" });
  }

  close(): void {
    this.lastOffer = null;
    this.state = { phase: "closed", shown: null, fading: null, pending: null };
    this.send({ kind: "close" });
  }

  pointerOn(key: string | null): void {
    if (key === this.pointerKey) return;
    this.pointerKey = key;
    this.send({ kind: "wanted", key });
  }

  // ─── The backend ──────────────────────────────────────────────────────

  private open(trigger: ScreenRect): void {
    const { plan } = this.options;
    this.opening = true;
    this.commands.open({ page: PAGE, show: this.show, panel: plan.panel, trigger, side: plan.side, look: plan.look }).then(
      () => {
        if (this.ended) return;
        this.opened = true;
        const held = this.held;
        this.held = [];
        for (const step of held) this.post(step);
      },
      (reason: unknown) => {
        if (this.ended) return;
        // A refusal is an answer, not a failure: the preview goes inside
        // (SPEC_OUTSIDE_WINDOW.md, НО9). Anything else is logged first.
        if (typeof reason !== "string") logFailure("the showing could not open", reason);
        this.refuse(this.lastOffer);
      },
    );
  }

  private send(step: PreviewStep): void {
    if (this.ended) return;
    if (this.opened) this.post(step);
    else this.held.push(step);
  }

  private post(step: PreviewStep): void {
    this.sent += 1;
    this.commands.step({ page: PAGE, show: this.show, number: this.sent, step }).catch((error: unknown) => logFailure(`the step ${step.kind} did not reach the backend`, error));
  }

  private refuse(offered: { target: TTarget; card: TCard } | null): void {
    this.finish({ kind: "refused" }, offered);
  }

  private finish(end: OutsideStageEnd, offered: { target: TTarget; card: TCard } | null): void {
    if (this.ended) return;
    this.ended = true;
    this.held = [];
    showings.delete(this.show);
    this.state = { phase: "closed", shown: null, fading: null, pending: null };
    this.options.onEnd(end, offered);
  }

  private hear(message: OutsideSourceMessage): void {
    if (message.kind === "closed") {
      const wasShown = this.state.shown !== null;
      if (wasShown) this.options.host.onHidden();
      this.finish({ kind: "ended", reason: message.reason }, null);
      return;
    }
    for (const due of this.reports.take(message.number, message)) {
      if (due.kind === "preview") this.take(due.report);
    }
  }

  private take(report: PreviewReport): void {
    // Only a report that has taken every step sent says what the window is
    // now; an earlier one still tells what happened.
    if (report.applied >= this.sent) {
      this.state = { phase: report.phase, shown: report.shown_key, fading: report.fading_key, pending: report.pending_key };
    }
    const event = report.event;
    if (event === null) return;
    const { host } = this.options;
    switch (event.kind) {
      case "settled": {
        const target = this.targets.get(event.key);
        if (target) host.onSettled(target);
        return;
      }
      case "hidden":
        host.onHidden();
        return;
      case "dropped":
        host.onDropped(event.reason);
        return;
      case "closed":
        this.finish({ kind: "closed" }, null);
    }
  }
}
