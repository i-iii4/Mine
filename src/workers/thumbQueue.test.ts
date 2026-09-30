import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThumbQueue } from "./thumbQueue";

interface Request {
  id: string;
  slug: string;
}

describe("thumbnail queue (А8.5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("frees the places of requests that never end", async () => {
    const succeeded = vi.fn();
    const failed = vi.fn();
    const hung = new Set(["a", "b", "c", "d"]);
    const queue = createThumbQueue<Request>({
      concurrency: 4,
      timeoutMs: 1_000,
      produce: (request) => (hung.has(request.slug)
        ? new Promise<ArrayBuffer>(() => undefined)
        : Promise.resolve(new ArrayBuffer(1))),
      succeeded: (request) => succeeded(request.slug),
      failed: (request, error) => failed(request.slug, error),
    });
    for (const slug of ["a", "b", "c", "d", "e"]) queue.push({ id: slug, slug });

    await vi.advanceTimersByTimeAsync(10);
    expect(succeeded).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(failed).toHaveBeenCalledTimes(4);
    expect(failed.mock.calls[0]?.[1]).toContain("took longer than 1000 ms");
    expect(succeeded).toHaveBeenCalledWith("e");
  });

  it("stays silent about requests the main thread cancelled", async () => {
    const failed = vi.fn();
    const queue = createThumbQueue<Request>({
      concurrency: 1,
      timeoutMs: 1_000,
      produce: (_request, signal) => new Promise<ArrayBuffer>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      succeeded: vi.fn(),
      failed,
    });
    queue.push({ id: "a", slug: "a" });
    queue.push({ id: "b", slug: "b" });
    queue.cancelAll();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(failed).not.toHaveBeenCalled();
  });
});
