import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_PATCH_GATHER_MS,
  createFeedPatchQueue,
  feedPatchAnnounces,
  noteOwnFeedChange,
  noteOwnFeedChangeFailed,
  takeOwnFeedChanges,
  type FeedPatchOutcome,
  type FeedPatchRequest,
} from "./feedChanges";

describe("the journal of the page's own commands", () => {
  beforeEach(() => {
    takeOwnFeedChanges();
  });

  it("holds nothing until a command answers", () => {
    expect(takeOwnFeedChanges()).toBeNull();
  });

  it("gathers the cards of every command since the last take, each once", () => {
    noteOwnFeedChange([3, 1]);
    noteOwnFeedChange([1, 7]);
    expect(takeOwnFeedChanges()).toEqual({ cards: [3, 1, 7], unknown: false });
    expect(takeOwnFeedChanges()).toBeNull();
  });

  it("tells a command that changed no card from no command at all", () => {
    noteOwnFeedChange([]);
    expect(takeOwnFeedChanges()).toEqual({ cards: [], unknown: false });
  });

  it("is unknown once a command named no list or failed", () => {
    noteOwnFeedChange([4]);
    noteOwnFeedChange(null);
    expect(takeOwnFeedChanges()).toEqual({ cards: [4], unknown: true });
    noteOwnFeedChangeFailed();
    expect(takeOwnFeedChanges()).toEqual({ cards: [], unknown: true });
  });
});

describe("the queue of partial reads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function queueWith(patch: (request: FeedPatchRequest) => Promise<FeedPatchOutcome>) {
    const readInFull = vi.fn(async () => {});
    const onError = vi.fn();
    const patchMock = vi.fn(patch);
    const queue = createFeedPatchQueue({ patch: patchMock, readInFull, onError });
    return { queue, patch: patchMock, readInFull, onError };
  }

  it("reads a command's cards at once and a preview's after the gathering time", async () => {
    const { queue, patch } = queueWith(async () => "applied");
    queue.note([1], "preview");
    await vi.advanceTimersByTimeAsync(FEED_PATCH_GATHER_MS - 1);
    expect(patch).not.toHaveBeenCalled();
    queue.note([2], "own_command");
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0].cards).toEqual([1, 2]);
    // The read is told by the strongest of those who named its cards.
    expect(patch.mock.calls[0]![0].reason).toBe("own_command");
    queue.dispose();
  });

  it("tells a read by the strongest of those who named its cards", async () => {
    const { queue, patch } = queueWith(async () => "applied");
    queue.note([1], "preview");
    queue.note([2], "card_menu");
    queue.note([3], "news");
    queue.note([4], "preview");
    await vi.runAllTimersAsync();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0].reason).toBe("news");
    expect(feedPatchAnnounces("news")).toBe(true);
    expect(feedPatchAnnounces("own_command")).toBe(true);
    expect(feedPatchAnnounces("card_menu")).toBe(false);
    expect(feedPatchAnnounces("preview")).toBe(false);
    queue.dispose();
  });

  it("drops what waits and supersedes the read in flight when the place changes", async () => {
    let request!: FeedPatchRequest;
    let finish!: (outcome: FeedPatchOutcome) => void;
    const { queue, patch, readInFull } = queueWith((asked) => {
      request = asked;
      return new Promise<FeedPatchOutcome>((resolve) => { finish = resolve; });
    });
    queue.note([1], "own_command");
    await vi.advanceTimersByTimeAsync(0);
    queue.note([2], "own_command");
    queue.reset();
    expect(request.superseded()).toBe(true);
    finish("full");
    await vi.runAllTimersAsync();
    // Card 2 was dropped, and the superseded read asked for no full read.
    expect(patch).toHaveBeenCalledTimes(1);
    expect(readInFull).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("gathers a burst of previews into one read, each card once", async () => {
    const { queue, patch } = queueWith(async () => "applied");
    for (let card = 0; card < 300; card += 1) {
      queue.note([card], "preview");
      queue.note([card], "preview");
    }
    await vi.runAllTimersAsync();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0].cards).toHaveLength(300);
    expect(patch.mock.calls[0]![0].reason).toBe("preview");
    queue.dispose();
  });

  it("keeps one read in flight and reads what came meanwhile after it", async () => {
    let finish!: (outcome: FeedPatchOutcome) => void;
    const { queue, patch } = queueWith(
      () => new Promise<FeedPatchOutcome>((resolve) => { finish = resolve; }),
    );
    queue.note([1], "own_command");
    await vi.advanceTimersByTimeAsync(0);
    queue.note([1, 2], "card_menu");
    await vi.advanceTimersByTimeAsync(100);
    expect(patch).toHaveBeenCalledTimes(1);
    finish("applied");
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]![0].cards).toEqual([1, 2]);
    queue.dispose();
  });

  it("waits for a full read in flight and reads only what was named after it began", async () => {
    const { queue, patch } = queueWith(async () => "applied");
    queue.note([1], "own_command");
    // The full read begins before the partial one: it covers card 1.
    queue.fullReadStarted();
    queue.note([2], "own_command");
    await vi.advanceTimersByTimeAsync(100);
    expect(patch).not.toHaveBeenCalled();
    queue.fullReadSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0].cards).toEqual([2]);
    queue.dispose();
  });

  it("tells a read in flight that a full read began after it", async () => {
    let request!: FeedPatchRequest;
    let finish!: (outcome: FeedPatchOutcome) => void;
    const { queue, readInFull } = queueWith((asked) => {
      request = asked;
      return new Promise<FeedPatchOutcome>((resolve) => { finish = resolve; });
    });
    queue.note([1], "own_command");
    await vi.advanceTimersByTimeAsync(0);
    expect(request.superseded()).toBe(false);
    queue.fullReadStarted();
    expect(request.superseded()).toBe(true);
    // Even an answer that asks for a full read starts none: one is under way.
    finish("full");
    await vi.advanceTimersByTimeAsync(0);
    expect(readInFull).not.toHaveBeenCalled();
    queue.fullReadSettled();
    queue.dispose();
  });

  it("reads the feed in full when the cards cannot be read into the list", async () => {
    const { queue, readInFull } = queueWith(async () => "full");
    queue.note([1], "own_command");
    await vi.runAllTimersAsync();
    expect(readInFull).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  it("reads the feed in full when the partial read failed, and says so", async () => {
    const failure = new Error("read failed");
    const { queue, readInFull, onError } = queueWith(async () => { throw failure; });
    queue.note([1], "own_command");
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(readInFull).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  it("settles once the named cards are read", async () => {
    let finish!: (outcome: FeedPatchOutcome) => void;
    const { queue } = queueWith(
      () => new Promise<FeedPatchOutcome>((resolve) => { finish = resolve; }),
    );
    await expect(queue.settled()).resolves.toBeUndefined();
    queue.note([1], "own_command");
    let settled = false;
    void queue.settled().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish("applied");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    queue.dispose();
  });

  it("reads what waits at once when flushed", async () => {
    const { queue, patch } = queueWith(async () => "applied");
    queue.note([1], "preview");
    queue.flush();
    await Promise.resolve();
    expect(patch).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  it("reads nothing after it is disposed and lets the waiting go", async () => {
    const { queue, patch } = queueWith(async () => "applied");
    queue.note([1], "preview");
    const settled = queue.settled();
    queue.dispose();
    queue.note([2], "own_command");
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toBeUndefined();
    expect(patch).not.toHaveBeenCalled();
  });
});
