import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_SCRIPT_CONTEXT, extractMetadata, openingStamps, remoteMediaNotice, requestXSyndication, requestYoutubeChannel,
  sendToNative, waitForYoutubeChannel, YOUTUBE_CHANNEL_TIMEOUT_MS,
} from "./messaging";

// SPEC_DEEP_AUDIT.md, Е4.17: the first openings waited 9 to 15 s for the
// collections. The first status and list requests of an opening carry its
// time, so the helper's journal tells where a slow opening spent it; a later
// refresh carries only its own send time and is never taken for the opening.
describe("stamps of an opening's helper requests", () => {
  it("carries the opening time once per kind of request", () => {
    const asked = new Set<string>();
    expect(openingStamps(1_000, asked, "get_status", 1_200)).toEqual({ _openedAt: 1_000, _sentAt: 1_200 });
    expect(openingStamps(1_000, asked, "list_channels", 1_300)).toEqual({ _openedAt: 1_000, _sentAt: 1_300 });
    expect(openingStamps(1_000, asked, "list_channels", 9_000)).toEqual({ _sentAt: 9_000 });
  });
});

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

// SPEC_DEEP_AUDIT.md, Е3.4: the clipper fills the address and title of a page
// whose content script did not answer into the metadata it gets. The next
// opening on another page must not find them there.
describe("metadata of a page without its content script", () => {
  it("gives every opening empty metadata of its own", async () => {
    const first = await extractMetadata(CONTENT_SCRIPT_CONTEXT);
    first.url = "https://a.example/first";
    first.title = "First page";
    const second = await extractMetadata(CONTENT_SCRIPT_CONTEXT);
    expect(second.url).toBe("");
    expect(second.title).toBe("");
  });
});

// SPEC_DEEP_AUDIT.md, Н10: the media a Save left as links to their sites,
// counted for the clipper.
describe("media left as links", () => {
  const remote = (count: number) => ({
    ok: true,
    remote_media: Array.from({ length: count }, (_, index) => ({
      url: `https://cdn.example/${index}.jpg`, kind: "image", reason: "download_failed",
    })),
  });
  it("says how many, or nothing when every one was saved", () => {
    expect(remoteMediaNotice(remote(1))).toBe("1 picture or video was not saved: it stays a link to its site.");
    expect(remoteMediaNotice(remote(3))).toBe("3 pictures or videos were not saved: they stay links to their sites.");
    expect(remoteMediaNotice(remote(0))).toBeNull();
    expect(remoteMediaNotice({ ok: true })).toBeNull();
  });
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
  // SPEC_DEEP_AUDIT.md, Н9: the background waits for a Save as long as the
  // helper says it works; the clipper waits for the background and has no
  // deadline of its own that would cut a long Save short.
  it("waits for a Save as long as the background does", async () => {
    vi.useFakeTimers();
    try {
      let answer: (response: unknown) => void = () => {};
      (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: (_message: unknown, callback: typeof answer) => { answer = callback; } } };
      const settled = vi.fn();
      const response = sendToNative({ action: "save_block" }).then(settled);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(settled).not.toHaveBeenCalled();
      answer({ ok: true, outcome: "committed" });
      await response;
      expect(settled).toHaveBeenCalledWith({ ok: true, outcome: "committed" });
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

// SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 6: the service refuses the
// page the overlay runs in, so the clipper asks background.
describe("syndication answer of an X post", () => {
  function answering(response: unknown) {
    const sendMessage = vi.fn((_message: unknown, callback: (reply: unknown) => void) => callback(response));
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage } };
    return sendMessage;
  }

  it("asks background for the post by its ID and answers the service's data", async () => {
    const data = { text: "Post", mediaDetails: [] };
    const sendMessage = answering({ ok: true, data });
    await expect(requestXSyndication("2001")).resolves.toEqual(data);
    expect(sendMessage).toHaveBeenCalledWith({ target: "background", action: "readXSyndication", tweetId: "2001" }, expect.any(Function));
  });

  it.each([
    ["a refusal", { ok: false, status: 404 }],
    ["data that is not an object", { ok: true, data: [1] }],
    ["no reply", undefined],
  ])("answers null for %s", async (_label, reply) => {
    answering(reply);
    await expect(requestXSyndication("2001")).resolves.toBeNull();
  });

  it("answers null when background stopped before replying", async () => {
    await expect(requestXSyndication("2001")).resolves.toBeNull();
  });

  it("answers null when the extension context is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: () => { throw new Error("Extension context invalidated."); } } };
    await expect(requestXSyndication("2001")).resolves.toBeNull();
    warn.mockRestore();
  });
});
