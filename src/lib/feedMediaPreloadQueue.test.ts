import { describe, expect, it } from "vitest";
import {
  FeedMediaPreloadQueue,
  type FeedMediaPreloadCandidate,
} from "./feedMediaPreloadQueue";

function candidate(
  url: string,
  distancePx: number,
  role: FeedMediaPreloadCandidate["role"] = "thumbnail",
  visualIndex = 0,
): FeedMediaPreloadCandidate {
  return { url, distancePx, role, visualIndex };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FeedMediaPreloadQueue", () => {
  it("caps active decodes and pumps queued candidates in priority order", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    const queue = new FeedMediaPreloadQueue({
      limits: {
        maxConcurrency: 2,
        queueLimit: 10,
        cacheLimit: 10,
        decodeTimeoutMs: 3000,
      },
      decodeImage: (url) => {
        started.push(url);
        return new Promise((resolve) => {
          resolvers.set(url, resolve);
        });
      },
    });

    const stats = queue.update({
      generation: "g1",
      candidates: [
        candidate("far-thumbnail", 300, "thumbnail", 3),
        candidate("near-tile", 50, "tile-preview", 2),
        candidate("near-primary", 50, "primary-preview", 1),
        candidate("mid-thumbnail", 100, "thumbnail", 4),
      ],
    });

    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(2);
    expect(started).toEqual(["near-primary", "near-tile"]);

    resolvers.get("near-primary")?.();
    await flushMicrotasks();

    expect(queue.stats()).toMatchObject({
      active: 2,
      queued: 1,
      decoded: 1,
    });
    expect(started).toEqual(["near-primary", "near-tile", "mid-thumbnail"]);
  });

  it("drops farthest queued candidates at the queue cap", () => {
    const queue = new FeedMediaPreloadQueue({
      limits: {
        maxConcurrency: 0,
        queueLimit: 3,
        cacheLimit: 10,
        decodeTimeoutMs: 3000,
      },
      decodeImage: async () => {},
    });

    const stats = queue.update({
      generation: "g1",
      candidates: [
        candidate("4", 400),
        candidate("1", 100),
        candidate("5", 500),
        candidate("2", 200),
        candidate("3", 300),
      ],
    });

    expect(stats.queued).toBe(3);
  });

  it("skips decoded URLs through the LRU", async () => {
    const queue = new FeedMediaPreloadQueue({
      limits: {
        maxConcurrency: 1,
        queueLimit: 10,
        cacheLimit: 10,
        decodeTimeoutMs: 3000,
      },
      decodeImage: async () => {},
    });

    queue.update({
      generation: "g1",
      candidates: [candidate("decoded", 0)],
    });
    await flushMicrotasks();

    const stats = queue.update({
      generation: "g1",
      candidates: [candidate("decoded", 0)],
    });

    expect(stats).toMatchObject({
      active: 0,
      queued: 0,
      decoded: 1,
      skippedLru: 1,
    });
  });

  it("suppresses failed URLs within a generation", async () => {
    let attempts = 0;
    const queue = new FeedMediaPreloadQueue({
      limits: {
        maxConcurrency: 1,
        queueLimit: 10,
        cacheLimit: 10,
        decodeTimeoutMs: 3000,
      },
      decodeImage: async () => {
        attempts += 1;
        throw new Error("decode failed");
      },
    });

    queue.update({
      generation: "g1",
      candidates: [candidate("broken", 0)],
    });
    await flushMicrotasks();
    const stats = queue.update({
      generation: "g1",
      candidates: [candidate("broken", 0)],
    });

    expect(attempts).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.active).toBe(0);
  });

  it("ignores stale completion after generation reset", async () => {
    const resolvers = new Map<string, () => void>();
    const queue = new FeedMediaPreloadQueue({
      limits: {
        maxConcurrency: 1,
        queueLimit: 10,
        cacheLimit: 10,
        decodeTimeoutMs: 3000,
      },
      decodeImage: (url) => new Promise((resolve) => {
        resolvers.set(url, resolve);
      }),
    });

    queue.update({
      generation: "g1",
      candidates: [candidate("old", 0)],
    });
    queue.update({
      generation: "g2",
      candidates: [candidate("new", 0)],
    });
    resolvers.get("old")?.();
    await flushMicrotasks();

    expect(queue.stats()).toMatchObject({
      generation: "g2",
      active: 1,
      decoded: 0,
      failed: 0,
    });
  });
});
