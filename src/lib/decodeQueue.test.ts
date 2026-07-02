import { describe, expect, it, vi } from "vitest";
import { DecodeQueue } from "./decodeQueue";

// Backoff used by the retry tests — advance fake timers past it.
const RETRY_DELAY_MS = 30_000;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("DecodeQueue", () => {
  it("runs at most `concurrency` tasks and starts them in FIFO order", async () => {
    const started: string[] = [];
    const gates = new Map<string, Deferred>();
    const queue = new DecodeQueue({ concurrency: 2, retryDelayMs: 1000, maxRetries: 1 });

    for (const key of ["a", "b", "c", "d"]) {
      const gate = deferred();
      gates.set(key, gate);
      queue.enqueue(key, async () => {
        started.push(key);
        await gate.promise;
      });
    }

    expect(started).toEqual(["a", "b"]);
    expect(queue.activeCount).toBe(2);
    expect(queue.size).toBe(2);

    gates.get("a")!.resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    gates.get("b")!.resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(queue.size).toBe(0);
  });

  it("ignores a duplicate key while queued or running, and allows re-enqueue after it settles", async () => {
    const started: string[] = [];
    const gate = deferred();
    const queue = new DecodeQueue({ concurrency: 1, retryDelayMs: 1000, maxRetries: 1 });

    const first = queue.enqueue("k", async () => {
      started.push("run1");
      await gate.promise;
    });
    const duplicate = queue.enqueue("k", async () => {
      started.push("run2");
    });

    expect(first).toBe(true);
    expect(duplicate).toBe(false);
    expect(started).toEqual(["run1"]);
    expect(queue.has("k")).toBe(true);

    gate.resolve();
    await flush();
    expect(queue.has("k")).toBe(false);

    expect(
      queue.enqueue("k", async () => {
        started.push("run3");
      }),
    ).toBe(true);
    await flush();
    expect(started).toEqual(["run1", "run3"]);
  });

  it("retries a failed key once after the backoff, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      let attempt = 0;
      const queue = new DecodeQueue({ concurrency: 1, retryDelayMs: 30_000, maxRetries: 1 });

      queue.enqueue("k", async () => {
        attempt += 1;
        attempts.push(attempt);
        if (attempt === 1) throw new Error("boom");
      });

      await flush();
      expect(attempts).toEqual([1]);
      expect(queue.has("k")).toBe(true);

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(attempts).toEqual([1, 2]);
      expect(queue.has("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after exhausting retries and reports via onGaveUp", async () => {
    vi.useFakeTimers();
    try {
      const gaveUp: Array<{ key: string; error: unknown }> = [];
      const queue = new DecodeQueue({
        concurrency: 1,
        retryDelayMs: 30_000,
        maxRetries: 1,
        onGaveUp: (key, error) => gaveUp.push({ key, error }),
      });

      queue.enqueue("k", async () => {
        throw new Error("always fails");
      });

      await flush();
      expect(gaveUp).toEqual([]);
      expect(queue.has("k")).toBe(true);

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(gaveUp).toHaveLength(1);
      expect(gaveUp[0]!.key).toBe("k");
      expect(gaveUp[0]!.error).toBeInstanceOf(Error);
      expect(queue.has("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a re-enqueue while a retry is pending in the backoff window", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const queue = new DecodeQueue({ concurrency: 1, retryDelayMs: 30_000, maxRetries: 1 });

      queue.enqueue("k", async () => {
        runs += 1;
        if (runs === 1) throw new Error("boom");
      });
      await flush();
      expect(queue.has("k")).toBe(true);

      const duplicate = queue.enqueue("k", async () => {
        runs += 1;
      });
      expect(duplicate).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      // The original entry retries and succeeds; the deduped task never ran.
      expect(runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose cancels pending retries and stops scheduling", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const queue = new DecodeQueue({ concurrency: 1, retryDelayMs: 30_000, maxRetries: 1 });

      queue.enqueue("k", async () => {
        runs += 1;
        throw new Error("boom");
      });
      await flush();
      expect(runs).toBe(1);

      queue.dispose();
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(runs).toBe(1);
      expect(queue.has("k")).toBe(false);
      expect(queue.enqueue("k", async () => {})).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
