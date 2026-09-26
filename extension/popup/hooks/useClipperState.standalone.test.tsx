// The mode decision (О2): the app when its host answers, the granted folder
// when it does not. These tests kill the host and watch which road a save
// takes — the payload must reach the standalone engine, not the native bridge.

import { createRequire } from "node:module";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import objktVideo from "../lib/fixtures/objkt-video.json";
import type { DurableClipperDraft } from "../lib/draft";

const { drafts } = vi.hoisted(() => ({ drafts: new Map<string, DurableClipperDraft>() }));
vi.mock("../lib/draft", () => ({
  readDraft: async (url: string) => drafts.get(url) ?? null,
  writeDraft: async (url: string, draft: DurableClipperDraft) => { drafts.set(url, draft); return draft; },
  clearDraft: async (url: string) => { drafts.delete(url); },
}));
vi.mock("../lib/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/protocol")>(),
  negotiateWidgetProtocol: async () => undefined,
}));

const { sendToNative, standalone, threadArticle } = vi.hoisted(() => ({
  threadArticle: { value: null as null | Record<string, unknown> },
  sendToNative: vi.fn(),
  standalone: {
    getStandaloneStatus: vi.fn(),
    standaloneSave: vi.fn(),
    standaloneLookup: vi.fn(),
    standaloneListChannels: vi.fn(),
    standaloneCreateChannel: vi.fn(),
    chooseStandaloneFolder: vi.fn(),
    regrantStandaloneAccess: vi.fn(),
    openStandaloneSetup: vi.fn(),
    canPickFolderHere: () => true,
  },
}));

vi.mock("../lib/messaging", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/messaging")>();
  return {
    ...original,
    sendToNative: (...args: unknown[]) => sendToNative(...args),
    getContextMenuData: async () => null,
    extractMetadata: async () => threadArticle.value
      ? { url: threadArticle.value.pageUrl ?? "https://x.com/author/status/10", title: "Thread", selection: "", detectedType: "content" }
      : { url: "https://example.com", title: "Page" },
    extractArticleAsync: async () => threadArticle.value,
  };
});

vi.mock("../lib/standalone", () => standalone);

// The hook reads `chrome` at module scope, so the global must exist before the
// import below evaluates — hoisted, like the mocks.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).chrome = { tabs: {} };
});

import { useClipperState } from "./useClipperState";
import * as messaging from "../lib/messaging";
import * as photoLightbox from "../lib/twitterPhotoLightbox";

// The generated Node binding executes the same compiled Rust/WASM as the worker.
const wasm: { execute_json: (command: string) => string } = createRequire(import.meta.url)(
  "../../../output/playwright/save-core-node/mine_core.js",
);

function mockChrome() {
  const localData: Record<string, unknown> = {};
  Object.assign((globalThis as Record<string, unknown>).chrome as object, {
    action: { setBadgeText: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...localData })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(localData, values); }),
        remove: vi.fn(async (key: string) => { delete localData[key]; }),
      },
      session: {
        get: vi.fn(async () => ({})),
        remove: vi.fn(),
      },
    },
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      lastError: undefined,
    },
    tabs: {
      captureVisibleTab: vi.fn(),
      query: vi.fn(async () => [{ id: 7, url: "https://example.com", title: "Page" }]),
      sendMessage: vi.fn((_id: number, _msg: unknown, cb?: (r: unknown) => void) => cb?.(null)),
      get: vi.fn(async () => ({ url: "https://example.com" })),
    },
  });
}

beforeEach(() => {
  drafts.clear();
  threadArticle.value = null;
  vi.clearAllMocks();
  mockChrome();
  standalone.getStandaloneStatus.mockResolvedValue({ configured: false });
  standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [] });
  standalone.standaloneLookup.mockResolvedValue({ ok: false, outcome: "unknown", error: "Operation outcome unknown" });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("standalone mode decision", () => {
  it("reports a collection load failure and clears it after retry", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper connection" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneListChannels.mockResolvedValue({ ok: false, error: "Cannot read index" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.channelsError).toBe("Could not load collections."));
    expect(result.current.channelsLoading).toBe(false);
    standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [{ tag: "Art", block_count: 3 }] });
    act(() => result.current.retryChannels());
    await waitFor(() => expect(result.current.channels).toEqual([{ tag: "Art", block_count: 3 }]));
    expect(result.current.channelsError).toBeNull();
    expect(result.current.channelsLoading).toBe(false);
  });
  it("ignores a delayed collection failure after switching spaces", async () => {
    sendToNative.mockImplementation(async (request: { action: string; vault_path?: string }) => {
      if (request.action === "get_status") return nativeStatus();
      return { ok: true, vaults: ["/v", "/b"], current: "/v", channels: [] };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.selectedVault).toBe("/v"));
    await waitFor(() => expect(result.current.channelsLoading).toBe(false));
    let resolveOld: ((value: unknown) => void) | undefined;
    sendToNative.mockImplementation(async (request: { action: string; vault_path?: string }) => {
      if (request.action === "get_status") return { ...nativeStatus(), vault_path: "/b", binding_id: "native-b" };
      if (request.action === "list_channels" && request.vault_path === "/v") return new Promise((resolve) => { resolveOld = resolve; });
      return { ok: true, vaults: ["/v", "/b"], channels: [{ tag: "New", block_count: 1 }] };
    });
    act(() => result.current.retryChannels());
    await waitFor(() => expect(resolveOld).toBeDefined());
    await act(async () => { await result.current.switchVault("/b"); });
    await act(async () => { resolveOld?.({ ok: false, error: "Old index failed" }); });
    expect(result.current.channels).toEqual([{ tag: "New", block_count: 1 }]);
    expect(result.current.channelsError).toBeNull();
    expect(result.current.channelsLoading).toBe(false);
  });
  it("restores title, collection order and screenshot bytes after the widget is destroyed", async () => {
    browserDestination();
    drafts.set("https://example.com", {
      schemaVersion: 1, revision: 3, draftId: "confirmed-draft",
      state: {
        metadata: { url: "https://example.com", title: "Page", description: "", image: null, author: null,
          ogType: null, favicon: null, selection: "", detectedType: "link", isArticle: false },
        articleData: null, title: "Confirmed title", selectedTags: ["Second", "First"], currentType: "link",
        selectedVault: null, screenshotDataUrl: "data:image/png;base64,AQID", screenshotUploadId: "expired-worker-id",
        executor: "browser", bindingId: "browser-original",
      },
    });
    const first = renderHook(() => useClipperState());
    await waitFor(() => expect(first.result.current.draftReady).toBe(true));
    expect(first.result.current.title).toBe("Confirmed title");
    expect(first.result.current.selectedTags).toEqual(["Second", "First"]);
    expect(first.result.current.screenshotDataUrl).toBe("data:image/png;base64,AQID");
    act(() => first.result.current.setTitle("Next confirmed edition"));
    await waitFor(() => expect(drafts.get("https://example.com")?.state.title).toBe("Next confirmed edition"));
    first.unmount();
    const reopened = renderHook(() => useClipperState());
    await waitFor(() => expect(reopened.result.current.draftReady).toBe(true));
    expect(reopened.result.current.title).toBe("Next confirmed edition");
    expect(reopened.result.current.screenshotDataUrl).toBe("data:image/png;base64,AQID");
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
  });

  function browserDestination() {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Clip" });
  }

  it("keeps the second X photo as an image with the post source", async () => {
    browserDestination();
    const url = "https://x.com/artist/status/123/photo/2";
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 7, url } as chrome.tabs.Tab]);
    const photo = vi.spyOn(photoLightbox, "fetchTweetPhotoByIndex").mockResolvedValue({ src: "https://pbs.twimg.com/media/second.jpg", alt: "Second", width: 800, height: 600 });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.currentType).toBe("image"));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(photo).toHaveBeenCalledWith("123", 1);
    expect(standalone.standaloneSave.mock.calls[0][0]).toMatchObject({
      block_type: "image", url: "https://x.com/artist/status/123", image_url: "https://pbs.twimg.com/media/second.jpg", body: "",
    });
  });

  it("saves the preview selection without rereading a changed page selection", async () => {
    browserDestination();
    vi.mocked(chrome.storage.session.get).mockImplementation(async (key) => key === "preloadedClipData" ? {
      preloadedClipData: { metadata: { url: "https://example.com/article", title: "Selection", selection: "Shown selection", detectedType: "selection" }, article: { content: "Full article", title: "Article", byline: null, excerpt: "" } },
    } : {});
    const read = vi.spyOn(messaging, "extractMetadata");
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.metadata?.selection).toBe("Shown selection"));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(read).not.toHaveBeenCalled();
    expect(standalone.standaloneSave.mock.calls[0][0]).toMatchObject({ body: "Shown selection", url: "https://example.com/article" });
  });

  it("discards extraction that completes after switching to Link", async () => {
    browserDestination();
    threadArticle.value = { pageUrl: "https://bsky.app/profile/author/post/123" };
    let finish!: (value: messaging.ArticleData) => void;
    const extract = vi.spyOn(messaging, "extractArticleAsync").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(extract).toHaveBeenCalled());
    act(() => result.current.setCurrentType("link"));
    await act(async () => finish({ title: "Late", content: "Late body", byline: null, excerpt: "", sourceUrl: "https://bsky.app/profile/other/post/456" }));
    expect(result.current.articleData?.content).not.toBe("Late body");
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave.mock.calls[0][0].url).toBe("https://bsky.app/profile/author/post/123");
  });

  it.each(["browser", "native"])("saves extracted source and content together through %s", async (executor) => {
    const sourceUrl = "https://bsky.app/profile/author.bsky.social/post/123";
    threadArticle.value = { pageUrl: "https://bsky.app", sourceUrl, title: "Post", content: "Exact post", byline: "author", excerpt: "" };
    standalone.getStandaloneStatus.mockResolvedValue(executor === "browser"
      ? { configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" }
      : { configured: false });
    let markdown = "";
    const execute = async (payload: Record<string, unknown>) => {
      const reply = JSON.parse(wasm.execute_json(JSON.stringify({ op: "capture", request: {
        ...payload, slug: "Cards/Post", tags: payload.tags ?? [], source: "web-clipper",
      } })));
      markdown = reply.value?.markdown ?? "";
      return { ok: reply.ok, outcome: "committed", slug: "Cards/Post" };
    };
    standalone.standaloneSave.mockImplementation(execute);
    sendToNative.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.action === "get_status") return executor === "native" ? nativeStatus() : { ok: false, error: "No helper" };
      if (payload.action === "list_known_vaults") return { ok: true, vaults: ["/v"], current: "/v" };
      if (payload.action === "list_channels") return { ok: true, channels: [] };
      if (payload.action === "save_block") return execute(payload);
      return { ok: false };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.articleData?.sourceUrl).toBe(sourceUrl));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(markdown).toContain(`url: ${sourceUrl}`);
    expect(markdown).toContain("Exact post");
  });

  it.each([
    ["browser", "preloaded"], ["native", "preloaded"],
    ["browser", "async"], ["native", "async"],
  ])("normalizes HTML video before preview and %s save (%s extraction)", async (executor, extraction) => {
    if (extraction === "async") threadArticle.value = { ...objktVideo.article, pageUrl: objktVideo.pageUrl };
    vi.mocked(chrome.storage.session.get).mockImplementation(async (keys) => extraction === "preloaded" && keys === "preloadedClipData" ? {
      preloadedClipData: {
        metadata: { url: objktVideo.pageUrl, title: objktVideo.article.title, selection: "", detectedType: "article" },
        article: objktVideo.article,
      },
    } : {});
    standalone.getStandaloneStatus.mockResolvedValue(executor === "browser"
      ? { configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" }
      : { configured: false });
    const save = vi.fn(async () => ({ ok: true, outcome: "committed", slug: "Cards/Objkt" }));
    standalone.standaloneSave.mockImplementation(save);
    sendToNative.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.action === "get_status") return executor === "native" ? nativeStatus() : { ok: false, error: "No helper" };
      if (payload.action === "list_known_vaults") return { ok: true, vaults: ["/v"], current: "/v" };
      if (payload.action === "list_channels") return { ok: true, channels: [] };
      if (payload.action === "save_block") return save();
      return { ok: false, error: "Unexpected native action" };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe(executor === "native" ? "app" : "standalone"));
    await waitFor(() => expect(result.current.articleData?.content).toContain(`![](${objktVideo.mediaUrl})`));
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    const previewBody = result.current.articleData?.content;
    expect(previewBody).not.toContain("<video");
    expect(result.current.articleData?.embeddedVideos).toHaveLength(1);
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    const payload = executor === "browser"
      ? standalone.standaloneSave.mock.calls[0][0]
      : sendToNative.mock.calls.find(([request]) => request.action === "save_block")?.[0];
    expect(payload).toMatchObject({ body: previewBody });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves the preview without extra confirmation despite a thread loading warning", async () => {
    threadArticle.value = { title: "Thread", content: "part one", byline: "author", excerpt: "", threadPostCount: 1, threadWarning: "Thread loading timed out." };
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-mine" });
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Thread" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.articleData?.threadWarning).toBe("Thread loading timed out."));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneSave.mock.calls[0][0]).toMatchObject({ body: "part one" });
  });

  it("saves both restricted X animations from the same recovered preview", async () => {
    browserDestination();
    const gif = "https://video.twimg.com/tweet_video/HTGOUI-a8AA8ROt.mp4";
    const video = "https://video.twimg.com/amplify_video/2103618771441360896/vid/avc1/1280x720/SRz40Vsis3bFBscQ.mp4?tag=14";
    const tweetId = "2103621844733714547";
    threadArticle.value = { pageUrl: `https://x.com/GasprArt/status/${tweetId}`,
      title: "Post", content: `Post\n\n![](${gif})`, byline: "@GasprArt", excerpt: "Post", threadPostCount: 1,
      twitterPosts: [{ id: tweetId, text: "Post", media: [{ kind: "video", url: gif, poster: null }] }],
    };
    sendToNative.mockImplementation(async request => request.action === "resolve_twitter_media"
      ? { ok: true, media: [] } : { ok: false, error: "No helper" });
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, media: [video, gif].map(src => ({
      kind: "video", src, poster: "https://pbs.twimg.com/media/frame.jpg",
    })) });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.articleData?.embeddedVideos).toHaveLength(2));
    const preview = result.current.articleData;
    expect(preview?.embeddedVideos?.map(m => m.src)).toEqual([video, gif]);
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave.mock.calls[0][0].body).toBe(preview?.content);
    expect(preview?.content).toBe(`Post\n\n![](${video})\n\n![](${gif})`);
  });
  it.each(["browser", "native"])("sends a real UI timestamp accepted by shared WASM through %s", async (executor) => {
    // Keep nonzero milliseconds in the clock: hand-written seconds-only requests
    // would miss the UI/core contract failure this regression protects against.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T15:20:30.789Z"));
    let outgoingTimestamp: unknown;
    let markdown: string | undefined;
    const executeCapture = async (payload: Record<string, unknown>) => {
      outgoingTimestamp = payload.saved_at;
      const reply: { ok: boolean; value?: { slug: string; markdown: string }; error?: { code: string; message: string } } =
        JSON.parse(wasm.execute_json(JSON.stringify({ op: "capture", request: {
          ...payload, slug: "Cards/Page", tags: payload.tags ?? [], source: "web-clipper",
        } })));
      markdown = reply.value?.markdown;
      return reply.ok
        ? { ok: true, outcome: "committed", slug: reply.value?.slug }
        : { ok: false, outcome: "not_committed", terminal_rejected: true, code: reply.error?.code, error: reply.error?.message };
    };
    standalone.standaloneSave.mockImplementation(executeCapture);
    standalone.getStandaloneStatus.mockResolvedValue(executor === "browser"
      ? { configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" }
      : { configured: false });
    sendToNative.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.action === "get_status") return executor === "native" ? nativeStatus() : { ok: false, error: "No helper" };
      if (payload.action === "list_known_vaults") return { ok: true, vaults: ["/v"], current: "/v" };
      if (payload.action === "list_channels") return { ok: true, channels: [] };
      if (payload.action === "save_block") return executeCapture(payload);
      return { ok: false, error: "Unexpected native action" };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe(executor === "native" ? "app" : "standalone"));
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    act(() => result.current.setCurrentType("link"));
    let outcome: { ok: boolean; error?: string } | undefined;
    await act(async () => { outcome = await result.current.save(); });
    expect(outcome).toMatchObject({ ok: true });
    expect(outgoingTimestamp).toBe("2026-08-31T15:20:30Z");
    expect(markdown).toContain("saved_at: 2026-08-31T15:20:30Z");
  });

  it("saves through the granted folder when the host is silent", async () => {
    sendToNative.mockImplementation(async (payload: { action: string }) => {
      if (payload.action === "get_status") return { ok: false, error: "Native host not installed" };
      return { ok: false, error: "unexpected native call: " + payload.action };
    });
    standalone.getStandaloneStatus.mockResolvedValue({
      configured: true,
      folderName: "Mine",
      bindingId: "browser-mine",
      permission: "granted",
    });
    standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [] });
    standalone.standaloneSave.mockResolvedValue({ ok: true, slug: "Page" });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.state).toBe("main"));
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    expect(result.current.standaloneFolder).toBe("Mine");
    // The app's absence is a mode, not an error banner.
    expect(result.current.nativeStatusError).toBeNull();

    // A page without a detected type defaults to a screenshot clip; this
    // test saves the link itself.
    act(() => {
      result.current.setCurrentType("link");
    });

    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.save();
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    const payload = standalone.standaloneSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.action).toBe("save_block");
    expect(payload.url).toBe("https://example.com");
    // Nothing besides the status probe may touch the dead host.
    const nativeActions = sendToNative.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(nativeActions.every((action) => action === "get_status")).toBe(true);
  });

  it("asks for a folder instead of erroring when nothing is configured", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "Native host not installed" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: false });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("unconfigured"));
    expect(result.current.nativeStatusError).toContain("Native host");

    standalone.chooseStandaloneFolder.mockResolvedValue({
      configured: true,
      folderName: "Clips",
      bindingId: "browser-clips",
      permission: "granted",
    });
    standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [] });

    await act(async () => {
      await result.current.chooseFolder();
    });

    expect(result.current.saveMode).toBe("standalone");
    expect(result.current.standaloneFolder).toBe("Clips");
    expect(result.current.nativeStatusError).toBeNull();
  });

  it("does not describe a restarted extension worker as a missing Mine helper", async () => {
    sendToNative.mockResolvedValue({
      ok: false,
      code: "extension_transport",
      error: "Mine extension background stopped before replying. Retry this action.",
    });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: false });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("unconfigured"));

    expect(result.current.nativeStatusError).toBe("Mine extension background stopped before replying. Retry this action.");
    expect(result.current.nativeStatusError).not.toContain("Mine helper");
  });

  it("keeps the native road untouched when the host answers", async () => {
    sendToNative.mockImplementation(async (payload: { action: string }) => {
      if (payload.action === "get_status") return nativeStatus();
      if (payload.action === "list_known_vaults") {
        return { ok: true, vaults: ["/v"], current: "/v" };
      }
      if (payload.action === "list_channels") return { ok: true, channels: [] };
      return { ok: true };
    });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.state).toBe("main"));
    await waitFor(() => expect(result.current.selectedVault).toBe("/v"));

    expect(result.current.saveMode).toBe("app");
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
  });

  it("distinguishes a connected helper without a folder from a connection error", async () => {
    sendToNative.mockResolvedValue({ ...nativeStatus(), vaultConfigured: false, vault_path: null, binding_id: null });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("unconfigured"));
    expect(result.current.nativeConnected).toBe(true);
    expect(result.current.nativeStatusError).toContain("Choose a folder");
    expect(result.current.nativeStatusError).not.toContain("not installed");
  });

  it("does not move a chosen browser folder when the helper becomes available", async () => {
    sendToNative.mockResolvedValue(nativeStatus());
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    expect(result.current.nativeConnected).toBe(true);
    expect(result.current.selectedVault).toBeNull();
  });

  it("does not silently replace a previously chosen native destination with a browser folder", async () => {
    await chrome.storage.local.set({ mineSaveDestination: { executor: "native", vaultPath: "/v", bindingId: "native-v" } });
    sendToNative.mockResolvedValue({ ok: false, error: "Connection rejected" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("unconfigured"));
    expect(result.current.nativeStatusError).toContain("Connection rejected");
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
  });

  it("pins operation ID and executor across unknown-result retries", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper connection" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: false, outcome: "unknown", error: "Response lost" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    act(() => result.current.setCurrentType("link"));
    await act(async () => { await result.current.save(); });
    expect(result.current.pendingOperation).toBe(true);
    const original = standalone.standaloneSave.mock.calls[0]![0] as { operation_id: string; binding_id: string };
    sendToNative.mockResolvedValue(nativeStatus());
    await act(async () => { await result.current.save(); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneLookup).toHaveBeenLastCalledWith(original.operation_id, original.binding_id);
    expect(sendToNative.mock.calls.some(([request]) => request.action === "save_block")).toBe(false);
  });

  it("requires explicit recovery instead of adopting another clip with the same URL", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper connection" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: false, outcome: "unknown" });
    const first = renderHook(() => useClipperState());
    await waitFor(() => expect(first.result.current.saveMode).toBe("standalone"));
    act(() => { first.result.current.setCurrentType("link"); first.result.current.setTitle("Clip A"); });
    await act(async () => { await first.result.current.save(); });
    const original = standalone.standaloneSave.mock.calls[0]![0] as { operation_id: string };
    first.unmount();

    const second = renderHook(() => useClipperState());
    await waitFor(() => expect(second.result.current.previousOperation?.id).toBe(original.operation_id));
    expect(second.result.current.pendingOperation).toBe(false);
    act(() => { second.result.current.setCurrentType("link"); second.result.current.setTitle("Clip B"); });
    let blocked: { ok: boolean } | undefined;
    await act(async () => { blocked = await second.result.current.save(); });
    expect(blocked?.ok).toBe(false);
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);

    act(() => second.result.current.confirmDifferentDraft());
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed" });
    await act(async () => { await second.result.current.save(); });
    expect(standalone.standaloneSave.mock.calls[1]![0]).toMatchObject({ title: "Clip B" });
    expect(standalone.standaloneSave.mock.calls[1]![0].operation_id).not.toBe(original.operation_id);
  });

  it("unlocks editing only after a durable terminal rejection confirms no effects", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper connection" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: false, outcome: "not_committed", terminal_rejected: true, code: "download_failed", error: "Download failed before writing" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    act(() => result.current.setCurrentType("link"));
    await act(async () => { await result.current.save(); });
    expect(result.current.pendingOperation).toBe(false);
    expect(Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith("minePendingSaveOperation:"))).toBe(false);
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed" });
    await act(async () => { await result.current.save(); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(2);
    expect(standalone.standaloneLookup).not.toHaveBeenCalled();
  });

  it("regrants the original operation binding after permission loss", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper connection" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: false, outcome: "unknown" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    act(() => result.current.setCurrentType("link"));
    await act(async () => { await result.current.save(); });
    standalone.regrantStandaloneAccess.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    await act(async () => { await result.current.regrantFolder(); });
    expect(standalone.regrantStandaloneAccess).toHaveBeenCalledWith("browser-original");
  });

  it("does not let a delayed old-folder status undo an explicit folder switch", async () => {
    sendToNative.mockImplementation(async (request: { action: string; vault_path?: string }) => {
      if (request.action === "get_status") return nativeStatus();
      if (request.action === "list_known_vaults") return { ok: true, vaults: ["/v", "/b"], current: "/v" };
      return { ok: true, channels: [] };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.selectedVault).toBe("/v"));
    let resolveOld: ((status: ReturnType<typeof nativeStatus>) => void) | undefined;
    let askedOld: (() => void) | undefined;
    const oldStarted = new Promise<void>((resolve) => { askedOld = resolve; });
    sendToNative.mockImplementation(async (request: { action: string; vault_path?: string }) => {
      if (request.action === "get_status" && request.vault_path === "/v") {
        askedOld?.();
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      if (request.action === "get_status") return { ...nativeStatus(), vault_path: "/b", binding_id: "native-b" };
      return { ok: true, vaults: ["/v", "/b"], channels: [] };
    });
    await act(async () => {
      const old = result.current.retryConnection();
      await oldStarted;
      const changed = result.current.switchVault("/b");
      resolveOld?.(nativeStatus());
      await Promise.all([old, changed]);
    });
    expect(result.current.selectedVault).toBe("/b");
    expect((await chrome.storage.local.get("mineSaveDestination")).mineSaveDestination).toMatchObject({ vaultPath: "/b", bindingId: "native-b" });
  });

  it("does not switch a missing selected browser folder to the native default", async () => {
    await chrome.storage.local.set({ mineSaveDestination: { executor: "browser", bindingId: "missing" } });
    sendToNative.mockResolvedValue(nativeStatus());
    standalone.getStandaloneStatus.mockResolvedValue({ configured: false });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("unconfigured"));
    expect(result.current.nativeStatusError).toContain("previously selected browser folder");
  });
});

function nativeStatus() {
  return { ok: true, connected: true, vaultConfigured: true, vault_path: "/v", binding_id: "native-v", features: ["save_operation_v1", "operation_lookup_v1"] };
}
