import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendToNative } from "./messaging";

beforeEach(() => {
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn((_message: unknown, callback: (response?: unknown) => void) => {
      runtime.lastError = { message: "A listener indicated an asynchronous response, but the message channel closed before a response was received." };
      callback();
      runtime.lastError = undefined;
    }),
  };
  (globalThis as Record<string, unknown>).chrome = { runtime };
});

describe("popup runtime transport", () => {
  it("does not time out before the background helper deadline", async () => {
    vi.useFakeTimers();
    try {
      let answer: (response: unknown) => void = () => {};
      (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: (_message: unknown, callback: typeof answer) => { answer = callback; } } };
      const settled = vi.fn();
      const response = sendToNative({ action: "get_status" }).then(settled);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).not.toHaveBeenCalled();
      answer({ ok: true });
      await response;
      expect(settled).toHaveBeenCalledWith({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("maps a restarted background worker separately from native-host availability", async () => {
    await expect(sendToNative({ action: "get_status" })).resolves.toMatchObject({
      ok: false,
      code: "extension_transport",
      error: "Mine extension background stopped before replying. Retry this action.",
      transport_error: expect.stringContaining("message channel closed"),
    });
  });
});
