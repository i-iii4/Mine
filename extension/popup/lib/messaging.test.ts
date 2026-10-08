import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestYoutubeChannel, sendToNative, waitForYoutubeChannel, YOUTUBE_CHANNEL_TIMEOUT_MS } from "./messaging";

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

// SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube».
describe("YouTube channel of a capture", () => {
  const sourceUrl = "https://www.youtube.com/watch?v=9KDDhAOyv9k";

  function answering(response: unknown) {
    const sendMessage = vi.fn((_message: unknown, callback: (reply: unknown) => void) => callback(response));
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage } };
    return sendMessage;
  }

  it("shares the 3 second bound with the background request", () => {
    expect(YOUTUBE_CHANNEL_TIMEOUT_MS).toBe(3_000);
  });

  it("asks background for the channel of the source video", async () => {
    const sendMessage = answering({ channel: "@kotecinho" });
    await expect(requestYoutubeChannel(sourceUrl)).resolves.toBe("@kotecinho");
    expect(sendMessage).toHaveBeenCalledWith(
      { target: "background", action: "resolveYoutubeChannel", sourceUrl },
      expect.any(Function),
    );
  });

  it.each([
    ["no channel", { channel: null }],
    ["a blank channel", { channel: "  " }],
    ["a channel of the wrong type", { channel: 7 }],
    ["no reply", undefined],
  ])("answers null for %s", async (_label, reply) => {
    answering(reply);
    await expect(requestYoutubeChannel(sourceUrl)).resolves.toBeNull();
  });

  it("answers null when background stopped before replying", async () => {
    await expect(requestYoutubeChannel(sourceUrl)).resolves.toBeNull();
  });

  it("answers null when the extension context is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: () => { throw new Error("Extension context invalidated."); } } };
    await expect(requestYoutubeChannel(sourceUrl)).resolves.toBeNull();
    warn.mockRestore();
  });

  it("waits for a late answer no longer than the bound, then goes on without a channel", async () => {
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const waiting = waitForYoutubeChannel(new Promise<string | null>(() => undefined)).then(settled);
      await vi.advanceTimersByTimeAsync(YOUTUBE_CHANNEL_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(settled).toHaveBeenCalledWith(null);
    } finally { vi.useRealTimers(); }
  });

  it("takes an answer that arrives within the bound and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      let answer: (channel: string | null) => void = () => undefined;
      const waiting = waitForYoutubeChannel(new Promise<string | null>((resolve) => { answer = resolve; }));
      await vi.advanceTimersByTimeAsync(YOUTUBE_CHANNEL_TIMEOUT_MS - 1);
      answer("@kotecinho");
      await expect(waiting).resolves.toBe("@kotecinho");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("goes on without a channel when the request fails", async () => {
    vi.useFakeTimers();
    try {
      await expect(waitForYoutubeChannel(Promise.reject(new Error("offline")))).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
