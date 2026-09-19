import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewRowQueue } from "./previewRowQueue";
import type { GridRowsSnapshot } from "@/types";
const snapshot: GridRowsSnapshot = { path: "/vault", generation: 1, blocks: [] };
afterEach(() => vi.useRealTimers());
describe("preview row queue", () => {
  it("coalesces duplicates and bounds large batches", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(snapshot);
    const apply = vi.fn();
    const q = createPreviewRowQueue({ fetch, apply, onError: vi.fn() });
    for (let i = 0; i < 450; i++) { q.add(String(i)); q.add(String(i)); }
    await vi.runAllTimersAsync();
    expect(fetch.mock.calls.map(([slugs]) => slugs.length)).toEqual([200, 200, 50]);
    expect(apply).toHaveBeenCalledTimes(3);
    q.dispose();
  });
  it("retains in-flight events without parallel reads", async () => {
    vi.useFakeTimers();
    let resolve!: (value: GridRowsSnapshot) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<GridRowsSnapshot>((r) => { resolve = r; })).mockResolvedValue(snapshot);
    const q = createPreviewRowQueue({ fetch, apply: vi.fn(), onError: vi.fn() });
    q.add("a"); await vi.advanceTimersByTimeAsync(32);
    q.add("a"); q.add("b"); await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(snapshot); await vi.runAllTimersAsync();
    expect(fetch.mock.calls).toEqual([[["a"]], [["a", "b"]]]);
    q.dispose();
  });
  it("discards a response from a disposed space or route", async () => {
    vi.useFakeTimers();
    let resolve!: (value: GridRowsSnapshot) => void;
    const apply = vi.fn();
    const q = createPreviewRowQueue({ fetch: () => new Promise((r) => { resolve = r; }), apply, onError: vi.fn() });
    q.add("same-slug"); await vi.advanceTimersByTimeAsync(32);
    q.dispose(); resolve(snapshot); await vi.runAllTimersAsync();
    expect(apply).not.toHaveBeenCalled();
  });
  it("cancels pending work on disposal", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    const q = createPreviewRowQueue({ fetch, apply: vi.fn(), onError: vi.fn() });
    q.add("a"); q.dispose(); q.add("b"); await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports failure and processes the next event", async () => {
    vi.useFakeTimers();
    const error = new Error("read failed");
    const fetch = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(snapshot);
    const onError = vi.fn(); const apply = vi.fn();
    const q = createPreviewRowQueue({ fetch, apply, onError });
    q.add("a"); await vi.runAllTimersAsync();
    q.add("a"); await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledWith(error); expect(apply).toHaveBeenCalledOnce();
    q.dispose();
  });
});
