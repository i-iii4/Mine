// Which cards the page knows changed, and the order its feed reads go in
// (SPEC_FRONTEND.md, «Обновление ленты»).
//
// Two parts. The journal of the page's own commands: every wrapper of a
// command that changes a space writes the cards the command named
// (`commands.ts`), and the page takes them when it refreshes after the
// command. The queue of partial reads: the named cards, whoever named them,
// are read one request at a time and never across a full read of the feed.

import type { FeedReadReason } from "@/types";

/** What the page's own commands named since it last took the journal. */
export interface OwnFeedChanges {
  /** `blocks.id` of the cards the commands changed, added or removed. */
  cards: number[];
  /** A command did not name its cards, or failed after it may have written:
   *  the feed is read in full. */
  unknown: boolean;
}

let ownCards = new Set<number>();
let ownUnknown = false;
let ownNoted = false;

/** A command of this page answered: `cards` are the cards it named, `null`
 *  when it named none it could tell (SPEC_INTEGRATION.md, «Список изменённых
 *  карточек»). */
export function noteOwnFeedChange(cards: readonly number[] | null): void {
  ownNoted = true;
  if (cards === null) {
    ownUnknown = true;
    return;
  }
  for (const card of cards) ownCards.add(card);
}

/** A command of this page that changes a space failed: part of its writes may
 *  have happened, so the feed is read in full. */
export function noteOwnFeedChangeFailed(): void {
  noteOwnFeedChange(null);
}

/** Take what the page's commands named since the last take. `null` when no
 *  command answered: the page has no list to read by. */
export function takeOwnFeedChanges(): OwnFeedChanges | null {
  if (!ownNoted) return null;
  const taken = { cards: [...ownCards], unknown: ownUnknown };
  ownCards = new Set();
  ownUnknown = false;
  ownNoted = false;
  return taken;
}

/** How long previews that became ready are gathered before their rows are
 *  read, so a burst of them is one read. */
export const FEED_PATCH_GATHER_MS = 32;

/** Who named cards for a partial read, strongest first: a read of cards
 *  named by several is told by the strongest. */
const PATCH_REASONS = ["own_command", "news", "card_menu", "preview"] as const satisfies readonly FeedReadReason[];
export type FeedPatchReason = (typeof PATCH_REASONS)[number];

/** Whether a read for `reason` changes what the space holds: the page then
 *  says the space was refreshed once the answer is in (`vault-refreshed`). A
 *  preview that became ready and a card's menu closing change no source. */
export function feedPatchAnnounces(reason: FeedPatchReason): boolean {
  return reason === "own_command" || reason === "news";
}

/** What one partial read is asked to do. */
export interface FeedPatchRequest {
  /** `blocks.id` of the cards to read. */
  cards: number[];
  /** Who named them, for the read's line in `Mine.log` and for
   *  [`feedPatchAnnounces`]. */
  reason: FeedPatchReason;
  /** Whether a full read began after this request: it covers these cards,
   *  and the answer is dropped. */
  superseded: () => boolean;
}

/** How a partial read ended: `applied`, or `full` when the cards cannot be
 *  read into the list and the feed has to be read in full. */
export type FeedPatchOutcome = "applied" | "full";

export interface FeedPatchQueue {
  /** Cards changed. A preview's cards are read after
   *  [`FEED_PATCH_GATHER_MS`], everyone else's at once. */
  note: (cards: readonly number[], reason: FeedPatchReason) => void;
  /** A full read of the feed begins: it covers every card named so far and
   *  the partial read in flight. */
  fullReadStarted: () => void;
  /** That full read came back, applied or not. */
  fullReadSettled: () => void;
  /** Read what waits now rather than at its timer (a hidden page's timers
   *  wait). */
  flush: () => void;
  /** The place, the order or the space changed: what waits is dropped and
   *  the read in flight is told it is superseded. The feed of the new place
   *  is read in full. */
  reset: () => void;
  /** Resolves once no named card waits or is being read. */
  settled: () => Promise<void>;
  dispose: () => void;
}

/** The queue of partial reads of a page's feed. One read is in flight at a
 *  time, and none while a full read is: a read that begins later is never
 *  older than one that began earlier, so answers apply in the order they
 *  were asked. One queue serves the page for its whole life, so a full read
 *  that began before the place changed is still counted after it. */
export function createFeedPatchQueue(options: {
  /** Read the cards and put the answer into the list. */
  patch: (request: FeedPatchRequest) => Promise<FeedPatchOutcome>;
  /** Read the feed in full, for the cards `reason` named; resolves when that
   *  read came back. */
  readInFull: (reason: FeedPatchReason) => Promise<unknown>;
  onError: (error: unknown) => void;
}): FeedPatchQueue {
  const pending = new Set<number>();
  let pendingReason: FeedPatchReason | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDueAt = 0;
  let running = false;
  let fullReads = 0;
  let fullReadEpoch = 0;
  let disposed = false;
  let waiters: Array<() => void> = [];

  function idle() {
    return disposed || (pending.size === 0 && !running && fullReads === 0);
  }

  function settleWaiters() {
    if (!idle() || waiters.length === 0) return;
    const resolved = waiters;
    waiters = [];
    for (const resolve of resolved) resolve();
  }

  function clearTimer() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function dropPending() {
    pending.clear();
    pendingReason = null;
  }

  function schedule(delayMs: number) {
    if (disposed || running || fullReads > 0 || pending.size === 0) return;
    const dueAt = performance.now() + delayMs;
    if (timer !== undefined) {
      // A read already due sooner stays.
      if (timerDueAt <= dueAt) return;
      clearTimer();
    }
    timerDueAt = dueAt;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  }

  async function run() {
    if (disposed || running || fullReads > 0 || pending.size === 0) return;
    clearTimer();
    const cards = [...pending];
    const reason = pendingReason ?? "preview";
    dropPending();
    const epoch = fullReadEpoch;
    running = true;
    let outcome: FeedPatchOutcome;
    try {
      outcome = await options.patch({ cards, reason, superseded: () => fullReadEpoch !== epoch });
    } catch (error) {
      if (!disposed) options.onError(error);
      // The cards were not read: the list is behind, and only a full read
      // is known to bring it up.
      outcome = "full";
    }
    running = false;
    if (disposed) return;
    if (outcome === "full" && fullReadEpoch === epoch) {
      try {
        await options.readInFull(reason);
      } catch (error) {
        if (!disposed) options.onError(error);
      }
    }
    schedule(0);
    settleWaiters();
  }

  return {
    note(cards, reason) {
      if (disposed || cards.length === 0) return;
      for (const card of cards) pending.add(card);
      if (pendingReason === null || PATCH_REASONS.indexOf(reason) < PATCH_REASONS.indexOf(pendingReason)) {
        pendingReason = reason;
      }
      schedule(reason === "preview" ? FEED_PATCH_GATHER_MS : 0);
    },
    fullReadStarted() {
      if (disposed) return;
      fullReads += 1;
      fullReadEpoch += 1;
      dropPending();
      clearTimer();
    },
    fullReadSettled() {
      if (disposed) return;
      fullReads = Math.max(0, fullReads - 1);
      schedule(0);
      settleWaiters();
    },
    flush() {
      void run();
    },
    reset() {
      if (disposed) return;
      fullReadEpoch += 1;
      dropPending();
      clearTimer();
      settleWaiters();
    },
    settled() {
      if (idle()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    dispose() {
      disposed = true;
      clearTimer();
      dropPending();
      settleWaiters();
    },
  };
}
