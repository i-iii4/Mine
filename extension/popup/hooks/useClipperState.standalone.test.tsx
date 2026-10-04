// The mode decision (О2): the app when its host answers, the granted folder
// when it does not. These tests kill the host and watch which road a save
// takes — the payload must reach the standalone engine, not the native bridge.

import { createRequire } from "node:module";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import objktVideo from "../lib/fixtures/objkt-video.json";
vi.mock("../lib/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/protocol")>(),
  negotiateWidgetProtocol: async () => undefined,
}));

// A launch set by a test; otherwise the clipper opened for the active tab.
const clipperLaunch = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
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
    getClipperLaunch: async () => {
      if (clipperLaunch.value) return clipperLaunch.value;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ? { sourceTabId: tab.id, sourceUrl: tab.url ?? null, sourceTitle: tab.title ?? null, contextMenu: null, preloaded: null } : null;
    },
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

import { CLIPPER_RECONNECT_INTERVAL_MS, DESTINATION_CHANGED_DURING_SAVE, MINE_NOT_CONNECTED, useClipperState } from "./useClipperState";
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
        remove: vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) delete localData[key]; }),
      },
      session: {
        get: vi.fn(async () => ({})),
        remove: vi.fn(),
      },
    },
    runtime: {
      // There is no page to capture here: background answers a screenshot
      // request with a refusal, which leaves the editor and its frame as they
      // are. Tests about screenshots answer requests themselves.
      sendMessage: vi.fn((message: { action?: string }, callback?: (response: unknown) => void) => {
        if (message?.action === "captureForCrop") {
          setTimeout(() => callback?.({ ok: false, error: "No page to capture in this test" }), 0);
        }
      }),
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
  clipperLaunch.value = null;
  threadArticle.value = null;
  vi.clearAllMocks();
  mockChrome();
  standalone.getStandaloneStatus.mockResolvedValue({ configured: false });
  standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [] });
  standalone.standaloneLookup.mockResolvedValue({ ok: false, outcome: "unknown", error: "Operation outcome unknown" });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("standalone mode decision", () => {
  it("saves into the browser folder while the helper does not answer (А3.11)", async () => {
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Clip" });
    await chrome.storage.local.set({ mineSaveDestination: { executor: "browser", bindingId: "browser-original" } });
    sendToNative.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    await settled(result);
    act(() => result.current.setCurrentType("link"));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the editor and says why when a collection cannot be created (А3.10)", async () => {
    browserDestination();
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    standalone.standaloneCreateChannel.mockResolvedValueOnce({ ok: false, error: "Restore access to the saved folder" });
    await act(async () => { await result.current.createChannel("Reference"); });
    expect(standalone.standaloneCreateChannel).toHaveBeenCalledWith("Reference", "browser-original");
    expect(result.current.state).toBe("main");
    expect(result.current.collectionError).toBe("Restore access to the saved folder");
    expect(result.current.canSave).toBe(true);
    standalone.standaloneCreateChannel.mockResolvedValueOnce({ ok: true, tag: "Reference" });
    await act(async () => { await result.current.createChannel("Reference"); });
    expect(result.current.collectionError).toBeNull();
    expect(result.current.selectedTags).toEqual(["Reference"]);
  });

  it("does not select a created collection after its destination was replaced", async () => {
    browserDestination();
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    let finish: ((value: { ok: boolean; tag: string }) => void) | undefined;
    standalone.standaloneCreateChannel.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const creating = result.current.createChannel("Old folder collection");
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? { ...nativeStatus(), vault_path: "/new", binding_id: "native-new" } : { ok: true, channels: [], vaults: ["/new"] });
    await act(async () => { await result.current.switchVault("/new"); });
    await act(async () => { finish?.({ ok: true, tag: "Old folder collection" }); await creating; });
    expect(result.current.selectedVault).toBe("/new");
    expect(result.current.selectedTags).toEqual([]);
  });

  it("uploads the current screenshot when the cache reply of an older frame arrives later", async () => {
    const oldBytes = "data:image/png;base64,AQID";
    const newBytes = "data:image/png;base64,BAUG";
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? { ...nativeStatus(), upload_port: 1234, upload_token: "token", features: [...nativeStatus().features, "pending_uploads_v1"] }
      : { ok: true, channels: [], vaults: ["/v"] });
    let finishOld: ((id: string) => void) | undefined;
    vi.spyOn(messaging, "cacheScreenshotUpload").mockImplementation(async bytes => bytes === oldBytes
      ? new Promise(resolve => { finishOld = resolve; }) : "new-upload");
    const upload = vi.spyOn(messaging, "uploadFile").mockResolvedValue({ ok: true, upload_id: "staged-new" });
    // The window asks background to capture its source tab (Ф6); neither
    // frame comes with a cached upload, so the editor caches each itself.
    const frames = [oldBytes, newBytes];
    const capture = vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { action?: string }, callback?: (r: unknown) => void) => {
      if (message.action === "captureForCrop") callback?.({ ok: true, dataUrl: frames.shift() });
    }) as unknown as typeof chrome.runtime.sendMessage);
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(finishOld).toBeDefined());
    await settled(result);
    expect(result.current.currentType).toBe("screenshot");
    act(() => result.current.retakeScreenshot());
    expect(capture).toHaveBeenCalledWith({ target: "background", action: "captureForCrop", tabId: 7, documentUrl: "https://example.com" }, expect.any(Function));
    await waitFor(() => expect(result.current.screenshotDataUrl).toBe(newBytes));
    await act(async () => { finishOld?.("old-upload"); });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(upload.mock.calls[0]?.[3]).toBe("new-upload");
  });
  it("never shows a committed save left in the journal as unresolved, and removes it on opening (Т6)", async () => {
    browserDestination();
    const key = "minePendingSaveOperation:left-behind";
    // A record whose removal failed after its save committed.
    await chrome.storage.local.set({ [key]: { schemaVersion: 1, id: "left-behind", executor: "browser", bindingId: "browser-original",
      vaultPath: null, sourceUrl: "https://example.com", attempted: true,
      payload: { action: "save_block", url: "https://example.com", title: "Saved before" },
      terminalResult: { ok: true, outcome: "committed", slug: "Cards/Saved-before" } } });
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    await waitFor(async () => expect((await chrome.storage.local.get(null))[key]).toBeUndefined());
    expect(result.current.previousOperation).toBeNull();
    act(() => { result.current.setCurrentType("link"); result.current.setTitle("Next clip"); });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneSave.mock.calls[0]?.[0]).toMatchObject({ title: "Next clip" });
    expect(standalone.standaloneLookup).not.toHaveBeenCalled();
  });
  it("saves the visible edits and a repeated Save of the committed clip does not dispatch again", async () => {
    browserDestination();
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => { result.current.setCurrentType("link"); result.current.setTitle("Current title"); result.current.toggleTag("Art"); });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave.mock.calls[0]?.[0]).toMatchObject({ title: "Current title", tags: ["Art"] });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
  });
  it("refuses dispatch when the mandatory save journal cannot be stored", async () => {
    browserDestination();
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => result.current.setCurrentType("link"));
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error("Save journal storage unavailable"));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: false, error: "Save journal storage unavailable" }); });
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
  });
  it("leaves no journal record after a committed Save; reopening shows no previous save and Save stays available (Т3)", async () => {
    browserDestination();
    const first = renderHook(() => useClipperState());
    await settled(first.result);
    act(() => first.result.current.setCurrentType("link"));
    await act(async () => { expect(await first.result.current.save()).toMatchObject({ ok: true }); });
    const operationId = standalone.standaloneSave.mock.calls[0]?.[0].operation_id;
    const key = `minePendingSaveOperation:${operationId}`;
    await waitFor(async () => expect((await chrome.storage.local.get(null))[key]).toBeUndefined());
    await act(async () => { expect(await first.result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useClipperState());
    await settled(second.result);
    expect(second.result.current.previousOperation).toBeNull();
    expect(second.result.current.canSave).toBe(true);
    act(() => second.result.current.setCurrentType("link"));
    await act(async () => { expect(await second.result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(2);
  });
  it("keeps a confirmed source success when the recovery receipt cannot be stored", async () => {
    browserDestination();
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => result.current.setCurrentType("link"));
    const store = vi.mocked(chrome.storage.local.set).getMockImplementation();
    if (!store) throw new Error("Storage fixture is missing");
    vi.mocked(chrome.storage.local.set).mockImplementation(async values => {
      if (Object.values(values).some(value => value && typeof value === "object" && "terminalResult" in value)) {
        throw new Error("Receipt storage unavailable");
      }
      return store(values);
    });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    const operationId = standalone.standaloneSave.mock.calls[0]?.[0].operation_id;
    expect((await chrome.storage.local.get(null))[`minePendingSaveOperation:${operationId}`]).toMatchObject({ id: operationId, attempted: true });
  });
  it("confirms the same prepared journal after interrupted readback before its first dispatch", async () => {
    browserDestination();
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => { result.current.setCurrentType("link"); result.current.setTitle("Prepared visible title"); });
    const read = vi.mocked(chrome.storage.local.get).getMockImplementation();
    if (!read) throw new Error("Storage fixture is missing");
    let operationReads = 0;
    vi.mocked(chrome.storage.local.get).mockImplementation(async key => {
      if (typeof key === "string" && key.startsWith("minePendingSaveOperation:") && ++operationReads === 2) {
        throw new Error("Journal readback interrupted");
      }
      return read(key);
    });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: false, error: "Journal readback interrupted" }); });
    expect(result.current.pendingOperation).toBe(false);
    expect(result.current.savePinned).toBe(true);
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    const record = Object.values(stored).find(value => value && typeof value === "object" && "id" in value);
    expect(record).toMatchObject({ attempted: true, payload: { title: "Prepared visible title" } });
    act(() => result.current.setTitle("A different title"));
    expect(result.current.title).toBe("Prepared visible title");
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneSave.mock.calls[0]?.[0]).toMatchObject({ operation_id: record.id, title: "Prepared visible title" });
  });
  it("reports a folder picker failure while retaining the native editor and capture", async () => {
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? nativeStatus() : { ok: true, channels: [], vaults: ["/v"] });
    vi.spyOn(messaging, "pickVaultFolder").mockRejectedValueOnce(new Error("Picker interrupted"));
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => { result.current.setTitle("Keep this title"); result.current.toggleTag("Art"); });
    await act(async () => { await result.current.addSpace(); });
    expect(result.current.nativeStatusError).toBe("Picker interrupted");
    expect(result.current.saveMode).toBe("app");
    expect(result.current.selectedVault).toBe("/v");
    expect(result.current.title).toBe("Keep this title");
    expect(result.current.selectedTags).toEqual(["Art"]);
  });
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

  it("saves every product photo although they share one alt text (А3.1)", async () => {
    browserDestination();
    const meta: messaging.PageMetadata = { url: "https://shop.example/p", documentUrl: "https://shop.example/p", captureGeneration: "g:1",
      title: "Meridian", description: "", image: null, author: null, ogType: null, favicon: null, selection: "", detectedType: "content", isArticle: true };
    vi.spyOn(messaging, "extractMetadata").mockResolvedValue(meta);
    const photos = Array.from({ length: 9 }, (_, i) => `![Meridian](https://shop.example/media/${i}.jpg)`).join("\n\n");
    vi.spyOn(messaging, "extractArticleAsync").mockResolvedValue({ title: "Meridian", content: `${photos}\n\nA geometric book.`,
      byline: null, excerpt: "", documentUrl: meta.documentUrl, sourceUrl: meta.url, captureGeneration: meta.captureGeneration });
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => result.current.setCurrentType("content"));
    await waitFor(() => expect(result.current.articleExtractionState).toBe("ready"));
    expect(result.current.articleData?.content.match(/!\[/g)).toHaveLength(9);
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    const body = String(standalone.standaloneSave.mock.calls[0]?.[0].body);
    expect([...body.matchAll(/media\/(\d)\.jpg/g)].map(match => match[1])).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("saves the preview selection without rereading a changed page selection", async () => {
    browserDestination();
    clipperLaunch.value = { sourceTabId: 7, sourceUrl: "https://example.com/article", sourceTitle: "Selection", contextMenu: null,
      preloaded: { metadata: { url: "https://example.com/article", title: "Selection", selection: "Shown selection", detectedType: "selection" }, article: { content: "Full article", title: "Article", byline: null, excerpt: "" } } };
    const read = vi.spyOn(messaging, "extractMetadata");
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.metadata?.selection).toBe("Shown selection"));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(read).not.toHaveBeenCalled();
    // The selection mark tells both executors to save the text as shown (Ф5).
    expect(standalone.standaloneSave.mock.calls[0][0]).toMatchObject({ body: "Shown selection", url: "https://example.com/article", selection: true });
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
      if (payload.action === "get_status") return executor === "native"
        ? { ...nativeStatus(), features: [...nativeStatus().features, "local_saved_at_v1"] }
        : { ok: false, error: "No helper" };
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
    if (extraction === "preloaded") {
      clipperLaunch.value = { sourceTabId: 7, sourceUrl: objktVideo.pageUrl, sourceTitle: objktVideo.article.title, contextMenu: null,
        preloaded: {
          metadata: { url: objktVideo.pageUrl, title: objktVideo.article.title, selection: "", detectedType: "article" },
          article: objktVideo.article,
        } };
    }
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
    await settled(result);
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
    // A local clock reading: saved_at is the wall clock without a zone.
    vi.setSystemTime(new Date(2026, 7, 31, 15, 20, 30, 789));
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
      if (payload.action === "get_status") return executor === "native"
        ? { ...nativeStatus(), features: [...nativeStatus().features, "local_saved_at_v1"] }
        : { ok: false, error: "No helper" };
      if (payload.action === "list_known_vaults") return { ok: true, vaults: ["/v"], current: "/v" };
      if (payload.action === "list_channels") return { ok: true, channels: [] };
      if (payload.action === "save_block") return executeCapture(payload);
      return { ok: false, error: "Unexpected native action" };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe(executor === "native" ? "app" : "standalone"));
    await settled(result);
    act(() => result.current.setCurrentType("link"));
    let outcome: { ok: boolean; error?: string } | undefined;
    await act(async () => { outcome = await result.current.save(); });
    expect(outcome).toMatchObject({ ok: true });
    expect(outgoingTimestamp).toBe("2026-08-31T15:20:30");
    expect(markdown).toContain("saved_at: 2026-08-31T15:20:30\n");
  });

  it("does not send a zoneless saved_at to a helper that has not declared it (К4)", async () => {
    let sent: Record<string, unknown> | undefined;
    sendToNative.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.action === "get_status") return nativeStatus();
      if (payload.action === "save_block") {
        sent = payload;
        return { ok: true, outcome: "committed", slug: "Cards/Page", operation_id: payload.operation_id };
      }
      return { ok: true, channels: [], vaults: ["/v"] };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("app"));
    await settled(result);
    act(() => result.current.setCurrentType("link"));
    await act(async () => { await result.current.save(); });
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("saved_at");
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
    expect(result.current.nativeStatusError).toBe(MINE_NOT_CONNECTED);

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

  it("connects by itself once Mine repairs the helper, with no button pressed", async () => {
    // Chrome's own words for an unregistered helper stay out of the clipper.
    let registered = false;
    sendToNative.mockImplementation(async (payload: { action: string }) => {
      if (payload.action !== "get_status") return { ok: true, vaults: ["/v"], current: "/v", channels: [] };
      return registered
        ? nativeStatus()
        : { ok: false, code: "native_disconnected", error: "Specified native messaging host not found.", outcome: "unknown" };
    });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: false });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.nativeStatusError).toBe(MINE_NOT_CONNECTED));
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.nativeStatusError).not.toContain("native messaging");

    // Mine opens and registers its helper.
    registered = true;
    await waitFor(() => expect(result.current.nativeStatusError).toBeNull(), { timeout: CLIPPER_RECONNECT_INTERVAL_MS + 2_000 });
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.saveMode).toBe("app");
    expect(result.current.selectedVault).toBe("/v");
  });

  it("does not describe a restarted extension worker as a missing Mine helper", async () => {
    sendToNative.mockResolvedValue({
      ok: false,
      code: "extension_transport",
      error: "Mine extension background stopped before replying. Retry this action.",
    });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: false });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.nativeStatusError).toContain("background stopped"));
    expect(result.current.saveMode).toBe("app");

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
    await chrome.storage.local.set({ mineSaveDestination: { executor: "native", vaultPath: "/v", bindingId: "native-v" }, mineKnownVaults: ["/v", "/b"] });
    sendToNative.mockResolvedValue({ ok: false, error: "Connection rejected" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.nativeStatusError).toBe(MINE_NOT_CONNECTED));
    expect(result.current.saveMode).toBe("app");
    expect(result.current.selectedVault).toBe("/v");
    expect(result.current.knownVaults).toEqual(["/v", "/b"]);
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

    act(() => second.result.current.confirmDifferentClip());
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

/// The clipper has opened and its destination check has settled.
async function settled(result: { current: ReturnType<typeof useClipperState> }) {
  await waitFor(() => {
    expect(result.current.state).toBe("main");
    expect(result.current.connectionChecking).toBe(false);
  });
}

describe("space identity (SPEC_CLIPPER.md, К1, К3, К6)", () => {
  const seedDestination = async (vaultPath: string, bindingId: string) => {
    await chrome.storage.local.set({ mineSaveDestination: { executor: "native", vaultPath, bindingId } });
  };
  // Helpers inside the messaging module reach the host through the runtime.
  const runtimeRequests: Record<string, unknown>[] = [];
  const routeRuntime = (respond: (request: Record<string, unknown>) => unknown) => {
    runtimeRequests.length = 0;
    const send = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    send.mockImplementation((message: { payload?: Record<string, unknown> }, callback?: (response: unknown) => void) => {
      // Only native requests carry a payload; a screenshot request does not.
      if (!message.payload) return;
      runtimeRequests.push(message.payload);
      callback?.(respond(message.payload));
    });
  };

  it("follows a renamed space by its identity and remembers the new path", async () => {
    await seedDestination("/Mine", "space-id");
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? { ...nativeStatus(), vault_path: "/Mine!", binding_id: "space-id", folder_state: "moved", moved_from: "/Mine", binding_accepted: true }
      : { ok: true, channels: [], vaults: ["/Mine!"] });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.selectedVault).toBe("/Mine!"));
    const status = sendToNative.mock.calls.map(([request]) => request as Record<string, unknown>)
      .find((request) => request.action === "get_status");
    expect(status).toMatchObject({ vault_path: "/Mine", binding_id: "space-id" });
    expect(result.current.nativeStatusError).toBeNull();
    const stored = await chrome.storage.local.get(["mineSaveDestination"]);
    expect(stored.mineSaveDestination).toEqual({ executor: "native", vaultPath: "/Mine!", bindingId: "space-id" });
  });

  it("accepts the identity binding that replaces a path binding from before К2", async () => {
    await seedDestination("/v", "a".repeat(64));
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? { ...nativeStatus(), binding_id: "space-id", binding_accepted: true }
      : { ok: true, channels: [], vaults: ["/v"] });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.channelsLoading).toBe(false));
    expect(result.current.nativeStatusError).toBeNull();
    const stored = await chrome.storage.local.get(["mineSaveDestination"]);
    expect(stored.mineSaveDestination).toMatchObject({ bindingId: "space-id" });
  });

  it("stops loading collections and lists the other spaces when the space is lost", async () => {
    await seedDestination("/Mine", "space-id");
    const lost = "“Mine” was renamed, moved or is on a disconnected drive. Choose a space.";
    sendToNative.mockImplementation(async (request: { action: string }) => {
      if (request.action === "get_status") {
        return { ...nativeStatus(), vaultConfigured: false, vault_path: null, binding_id: null,
          folder_state: "missing", binding_accepted: false, error: lost };
      }
      return { ok: true, channels: [] };
    });
    routeRuntime(() => ({ ok: true, vaults: ["/NSFV"], current: null }));
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.nativeStatusError).toBe(lost));
    expect(result.current.channelsLoading).toBe(false);
    await waitFor(() => expect(result.current.knownVaults).toEqual(["/NSFV"]));

    // Switching to another space clears the lost space's error.
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? { ...nativeStatus(), vault_path: "/NSFV", binding_id: "nsfv-id" }
      : { ok: true, channels: [{ tag: "Art", block_count: 1 }], vaults: ["/NSFV"] });
    await act(async () => { await result.current.switchVault("/NSFV"); });
    expect(result.current.nativeStatusError).toBeNull();
    await waitFor(() => expect(result.current.channels).toEqual([{ tag: "Art", block_count: 1 }]));
    expect(result.current.channelsLoading).toBe(false);
  });

  it("says why Mine cannot tell which space the folder is and keeps Save off until it can (Д2.1)", async () => {
    await seedDestination("/Mine copy", "space-id");
    const messages = {
      identity_in_cloud: "This space is still downloading from iCloud. Try again in a moment.",
      identity_unreadable: "Mine cannot read this space's identity file.",
      identity_unwritable: "This folder is a copy and Mine could not give it its own identity.",
    };
    let folderState = "identity_in_cloud";
    sendToNative.mockImplementation(async (request: { action: string }) => {
      if (request.action === "get_status") {
        return folderState === "ready"
          ? { ...nativeStatus(), vault_path: "/Mine copy", binding_id: "space-id", binding_accepted: true }
          : { ...nativeStatus(), vaultConfigured: false, vault_path: null, binding_id: null,
            folder_state: folderState, binding_accepted: false, error: "The helper's own sentence" };
      }
      return { ok: true, channels: [], vaults: ["/Mine copy"] };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.nativeStatusError).toBe(messages.identity_in_cloud));
    await waitFor(() => expect(result.current.state).toBe("main"));
    expect(result.current.saveMode).toBe("app");
    expect(result.current.canSave).toBe(false);

    for (const state of ["identity_unreadable", "identity_unwritable"] as const) {
      folderState = state;
      await act(async () => { await result.current.retryConnection(true); });
      expect(result.current.nativeStatusError).toBe(messages[state]);
      expect(result.current.canSave).toBe(false);
    }
    // Save asked anyway sends nothing to the helper.
    let outcome: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => { outcome = await result.current.save(); });
    expect(outcome).toEqual({ ok: false, error: messages.identity_unwritable });
    expect(sendToNative.mock.calls.some(([request]) => (request as { action: string }).action === "save_block")).toBe(false);

    folderState = "ready";
    await act(async () => { await result.current.retryConnection(true); });
    expect(result.current.nativeStatusError).toBeNull();
    await waitFor(() => expect(result.current.canSave).toBe(true));
  });

  it("shows the helper's own sentence for a state it does not know, without crashing", async () => {
    await seedDestination("/Mine", "space-id");
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? { ...nativeStatus(), vaultConfigured: false, vault_path: null, binding_id: null,
        folder_state: "a_state_from_a_newer_helper", binding_accepted: false, error: "The helper's own sentence" }
      : { ok: true, channels: [], vaults: ["/Mine"] });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.nativeStatusError).toBe("The helper's own sentence"));
    await waitFor(() => expect(result.current.state).toBe("main"));
    expect(result.current.saveMode).toBe("app");
  });

  it("reports why Reveal in Finder could not open the space", async () => {
    sendToNative.mockImplementation(async (request: { action: string }) => {
      if (request.action === "get_status") return nativeStatus();
      return { ok: true, channels: [], vaults: ["/v"] };
    });
    routeRuntime((request) => request.action === "reveal_vault"
      ? { ok: false, error: "“v” is not one of your Mine spaces." }
      : { ok: true, vaults: ["/v"], current: "/v" });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.selectedVault).toBe("/v"));
    let outcome: Awaited<ReturnType<typeof result.current.revealSpace>> | undefined;
    await act(async () => { outcome = await result.current.revealSpace("/v"); });
    expect(outcome).toEqual({ ok: false, error: "“v” is not one of your Mine spaces." });
    const reveal = runtimeRequests.find((request) => request.action === "reveal_vault");
    expect(reveal).toMatchObject({ path: "/v", binding_id: "native-v" });
  });
});

describe("collections while the helper indexes (SPEC_CLIPPER.md, К3)", () => {
  it("shows the names at once and the counts when indexing ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let indexing = true;
    sendToNative.mockImplementation(async (request: { action: string }) => {
      if (request.action === "get_status") return nativeStatus();
      if (request.action === "list_channels") {
        return indexing
          ? { ok: true, indexing: true, channels: [{ tag: "Art", block_count: null }] }
          : { ok: true, channels: [{ tag: "Art", block_count: 4 }] };
      }
      return { ok: true, vaults: ["/v"] };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.channels).toEqual([{ tag: "Art", block_count: null }]));
    expect(result.current.channelsLoading).toBe(false);
    expect(result.current.channelsNotice).toContain("indexing");
    indexing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await waitFor(() => expect(result.current.channels).toEqual([{ tag: "Art", block_count: 4 }]));
    expect(result.current.channelsNotice).toBeNull();
    expect(result.current.channelsLoading).toBe(false);
  });

  it("says the helper is busy instead of a failure when it does not answer in time", async () => {
    sendToNative.mockImplementation(async (request: { action: string }) => {
      if (request.action === "get_status") return nativeStatus();
      if (request.action === "list_channels") return { ok: false, code: "native_timeout", outcome: "unknown", error: "Mine helper did not respond in time" };
      return { ok: true, vaults: ["/v"] };
    });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.channelsError).toBe("Mine is busy with this space. Retry in a moment."));
    expect(result.current.channelsLoading).toBe(false);
    expect(result.current.canSave).toBe(true);
  });
});

describe("screenshots in the editor (SPEC_AUDIT_FIXES.md, Б4.5, Б4.6)", () => {
  const first = "data:image/jpeg;base64,AQID";
  const second = "data:image/jpeg;base64,BAUG";
  type Reply = (response: unknown) => void;
  type Sent = Record<string, unknown>;

  /// Background answers each request only when the test says so; a page
  /// without a detected type opens as a screenshot and asks for one at once.
  function answerLater(answers: Partial<Record<string, unknown>> = {}) {
    const captures: Reply[] = [];
    const sent: Sent[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: Sent, callback?: Reply) => {
      sent.push(message);
      if (message.action === "captureForCrop" && callback) captures.push(callback);
      else if (typeof message.action === "string" && message.action in answers) callback?.(answers[message.action]);
    }) as unknown as typeof chrome.runtime.sendMessage);
    return { captures, sent };
  }

  beforeEach(() => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
  });

  it("applies only the latest answer: an older request failing later leaves the editor and the newer frame", async () => {
    const { captures } = answerLater();
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(captures).toHaveLength(1));
    act(() => result.current.retakeScreenshot());
    expect(captures).toHaveLength(2);

    act(() => captures[1]!({ ok: true, dataUrl: second, screenshotId: "shot-2" }));
    act(() => captures[0]!({ ok: false, error: "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota." }));

    expect(result.current.state).toBe("main");
    expect(result.current.error).toBeNull();
    expect(result.current.screenshotDataUrl).toBe(second);
    expect(result.current.captureError).toBeNull();
    expect(result.current.capturing).toBe(false);
  });

  it("does not let an older frame arriving later replace the newer one", async () => {
    const { captures } = answerLater();
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(captures).toHaveLength(1));
    act(() => result.current.retakeScreenshot());
    act(() => captures[1]!({ ok: true, dataUrl: second, screenshotId: "shot-2" }));
    act(() => captures[0]!({ ok: true, dataUrl: first, screenshotId: "shot-1" }));
    expect(result.current.screenshotDataUrl).toBe(second);
  });

  it("shows a failed retake next to the frame it keeps, with the edits in place", async () => {
    const { captures } = answerLater();
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(captures).toHaveLength(1));
    act(() => captures[0]!({ ok: true, dataUrl: first, screenshotId: "shot-1" }));
    act(() => result.current.setTitle("Edited before the retake"));
    act(() => result.current.retakeScreenshot());
    act(() => captures[1]!({ ok: false, error: "The page is not in front of its window. Bring it forward and retake the screenshot." }));

    expect(result.current.state).toBe("main");
    expect(result.current.screenshotDataUrl).toBe(first);
    expect(result.current.title).toBe("Edited before the retake");
    expect(result.current.captureError).toContain("not in front");
    expect(result.current.capturing).toBe(false);
  });

  it("keeps Save unavailable during a retake and saves the new frame once it arrives (В4.5)", async () => {
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Shot" });
    const { captures } = answerLater();
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(captures).toHaveLength(1));
    act(() => captures[0]!({ ok: true, dataUrl: first, screenshotId: "shot-1" }));
    await settled(result);
    expect(result.current.canSave).toBe(true);

    act(() => result.current.retakeScreenshot());
    expect(result.current.capturing).toBe(true);
    expect(result.current.canSave).toBe(false);
    await act(async () => { expect(await result.current.save()).toBeUndefined(); });
    expect(standalone.standaloneSave).not.toHaveBeenCalled();

    act(() => captures[1]!({ ok: true, dataUrl: second, screenshotId: "shot-2" }));
    expect(result.current.canSave).toBe(true);
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneSave.mock.calls[0]![0]).toMatchObject({ block_type: "image", screenshot_data_url: second });
  });

  it("names the page address it opened for in every screenshot request", async () => {
    const { sent } = answerLater();
    renderHook(() => useClipperState());
    await waitFor(() => expect(sent.some((message) => message.action === "captureForCrop")).toBe(true));
    expect(sent.find((message) => message.action === "captureForCrop"))
      .toEqual({ target: "background", action: "captureForCrop", tabId: 7, documentUrl: "https://example.com" });
  });

  it("keeps the editor when the page refuses a crop from the window, and says why", async () => {
    const refusal = "This tab shows another page than the one Mine opened for. Open Mine again on the page you want to capture.";
    const { captures, sent } = answerLater({ startCropMode: { ok: false, error: refusal } });
    (chrome.storage.session as unknown as Record<string, unknown>).set = vi.fn(async () => undefined);
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(captures).toHaveLength(1));
    act(() => captures[0]!({ ok: true, dataUrl: first, screenshotId: "shot-1" }));
    await waitFor(() => expect(result.current.cropSupported).toBe(true));

    await act(async () => { await result.current.startCropMode(); });

    expect(sent.find((message) => message.action === "startCropMode"))
      .toEqual({ target: "background", action: "startCropMode", tabId: 7, documentUrl: "https://example.com", cropId: null });
    expect(result.current.state).toBe("main");
    expect(result.current.screenshotDataUrl).toBe(first);
    expect(result.current.captureError).toBe(refusal);
    expect(chrome.storage.session.remove).toHaveBeenCalledWith("cropPendingState");
  });
});

describe("a clip is never moved to another browser folder in silence (SPEC_AUDIT_FIXES.md, В4.4)", () => {
  function selectedFolder(folderName: string, bindingId: string) {
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName, permission: "granted", bindingId });
  }

  beforeEach(() => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Clip" });
    selectedFolder("Folder B", "browser-b");
  });

  it("drops the collections and names both folders when another folder is chosen elsewhere meanwhile", async () => {
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    await settled(result);
    act(() => { result.current.setCurrentType("link"); result.current.toggleTag("Collection of B"); });
    expect(result.current.selectedTags).toEqual(["Collection of B"]);

    selectedFolder("Folder C", "browser-c");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls
      .map(([registered]) => registered as unknown as (message: { action?: string }) => void);
    await act(async () => { listener.forEach((receive) => receive({ action: "mineStandaloneFolderChanged" })); });
    await waitFor(() => expect(result.current.standaloneFolder).toBe("Folder C"));
    expect(result.current.selectedTags).toEqual([]);
    expect(result.current.destinationNotice).toBe("This clip was made for “Folder B”. It will be saved to “Folder C”.");

    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave.mock.calls[0]![0]).toMatchObject({ binding_id: "browser-c", tags: null });
  });
});

describe("Save while the folder is being checked (SPEC_AUDIT_FIXES.md, Г3.2)", () => {
  const folder = (name: string, bindingId: string) => ({ configured: true, folderName: name, permission: "granted", bindingId });
  const sentTags = () => standalone.standaloneSave.mock.calls.map(([request]) => (request as { tags?: unknown }).tags);

  beforeEach(() => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Clip" });
  });

  it("a Save pressed while a folder change is being checked refuses with the notice; the next one saves to B without A's collections", async () => {
    const held: Array<() => void> = [];
    let checks = 0;
    standalone.getStandaloneStatus.mockImplementation(() => {
      checks += 1;
      // The clipper's own first check finds folder A; the check that the
      // folder change starts is still out when Save is pressed.
      if (checks === 1) return Promise.resolve(folder("Folder A", "browser-a"));
      if (checks === 2) return new Promise((resolve) => { held.push(() => resolve(folder("Folder B", "browser-b"))); });
      return Promise.resolve(folder("Folder B", "browser-b"));
    });
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    expect(result.current.standaloneFolder).toBe("Folder A");
    act(() => { result.current.setCurrentType("link"); result.current.setTitle("Clip made for A"); result.current.toggleTag("Collection of A"); });
    const listeners = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls
      .map(([registered]) => registered as unknown as (message: { action?: string }) => void);
    act(() => { listeners.at(-1)?.({ action: "mineStandaloneFolderChanged" }); });
    await waitFor(() => expect(held).toHaveLength(1));
    const canSaveDuringCheck = result.current.canSave;

    let saving: ReturnType<typeof result.current.save> = Promise.resolve(undefined);
    act(() => { saving = result.current.save(); });
    await act(async () => { held.forEach((finish) => finish()); });
    let refused: Awaited<typeof saving>;
    await act(async () => { refused = await saving; });

    // Nothing of folder A reached folder B.
    expect(sentTags()).not.toContainEqual(["Collection of A"]);
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
    expect(refused!).toEqual({ ok: false, error: DESTINATION_CHANGED_DURING_SAVE });
    expect(canSaveDuringCheck).toBe(false);
    expect(result.current.state).toBe("main");
    expect(result.current.destinationNotice).toBe("This clip was made for “Folder A”. It will be saved to “Folder B”.");
    expect(result.current.selectedTags).toEqual([]);
    expect(result.current.title).toBe("Clip made for A");
    expect(result.current.canSave).toBe(true);

    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneSave.mock.calls[0]![0]).toMatchObject({ binding_id: "browser-b", tags: null, title: "Clip made for A" });
  });

  it("a check that comes during a save does not move it; the editor follows the folder once the save ends", async () => {
    standalone.getStandaloneStatus.mockResolvedValue(folder("Folder B", "browser-b"));
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    await settled(result);
    act(() => { result.current.setCurrentType("link"); result.current.toggleTag("Collection of B"); });
    let finishSave: (response: unknown) => void = () => undefined;
    standalone.standaloneSave.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));

    let saving: ReturnType<typeof result.current.save> = Promise.resolve(undefined);
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(standalone.standaloneSave).toHaveBeenCalledTimes(1));
    // Folder C is chosen in another window; the folder row asks again meanwhile.
    standalone.getStandaloneStatus.mockResolvedValue(folder("Folder C", "browser-c"));
    await act(async () => { await result.current.retryConnection(true); });
    expect(result.current.standaloneFolder).toBe("Folder B");
    expect(result.current.selectedTags).toEqual(["Collection of B"]);
    expect(result.current.destinationNotice).toBeNull();

    // Folder B refuses: it is no longer the selected one.
    await act(async () => {
      finishSave({ ok: false, outcome: "not_committed", terminal_rejected: true, error: "The selected folder changed before this save began" });
      expect(await saving).toMatchObject({ ok: false, error: "The selected folder changed before this save began" });
    });
    expect(standalone.standaloneSave.mock.calls[0]![0]).toMatchObject({ binding_id: "browser-b", tags: ["Collection of B"] });
    await waitFor(() => expect(result.current.standaloneFolder).toBe("Folder C"));
    expect(result.current.selectedTags).toEqual([]);
    expect(result.current.destinationNotice).toBe("This clip was made for “Folder B”. It will be saved to “Folder C”.");
  });
});

describe("Save link clips the link, not the page it was clicked on (SPEC_AUDIT_FIXES.md, В4.2)", () => {
  const pageA = "https://a.example/story";
  const linkB = "https://b.example/article";

  beforeEach(() => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    standalone.standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Link" });
    clipperLaunch.value = { sourceTabId: 7, sourceUrl: pageA, sourceTitle: "Page A title", preloaded: null,
      contextMenu: { menuItemId: "save-link", linkUrl: linkB, pageUrl: pageA } };
    vi.spyOn(messaging, "extractMetadata").mockResolvedValue({ url: pageA, documentUrl: pageA, captureGeneration: "a:1",
      title: "Page A title", description: "About page A", image: "https://a.example/cover.jpg", author: "Author of A",
      ogType: "article", favicon: "https://a.example/favicon.ico", selection: "", detectedType: "link", isArticle: false });
  });

  const sentMessages = () => vi.mocked(chrome.runtime.sendMessage).mock.calls
    .map(([message]) => message as unknown as Record<string, unknown>);

  it("opens as Link without a screenshot of page A and saves link B with nothing of page A", async () => {
    const { result } = renderHook(() => useClipperState());
    await settled(result);

    expect(result.current.currentType).toBe("link");
    expect(sentMessages().some((message) => message.action === "captureForCrop")).toBe(false);
    expect(result.current.title).toBe("");
    expect(result.current.metadata).toMatchObject({ url: linkB, image: null, description: "", author: null });

    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    expect(standalone.standaloneSave.mock.calls[0]![0]).toMatchObject({
      block_type: "link", url: linkB, title: null, body: "", image_url: null, author: null,
    });
  });

  it("names link B for a screenshot, so the tab showing page A is refused rather than saved as B", async () => {
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    act(() => result.current.setCurrentType("screenshot"));
    expect(sentMessages().find((message) => message.action === "captureForCrop")).toMatchObject({ documentUrl: linkB });
  });
});

describe("a clip lives only in the open clipper (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч1, Ч2, Ч3)", () => {
  it("ignores drafts an earlier version stored: the fresh capture and the saved destination open (Т1)", async () => {
    sendToNative.mockImplementation(async (request: { action: string }) => request.action === "get_status"
      ? nativeStatus() : { ok: true, channels: [], vaults: ["/v", "/old"] });
    const oldState = { title: "Old draft title", selectedTags: ["Old collection"], currentType: "link",
      selectedVault: "/old", executor: "native", bindingId: "path-binding-of-old" };
    await chrome.storage.local.set({
      mineSaveDestination: { executor: "native", vaultPath: "/v", bindingId: "native-v" },
      "mineDurableDraft:https://example.com": { schemaVersion: 1, revision: 4, draftId: "old", state: oldState },
      "mineDurableDraftRecord:old": { schemaVersion: 2, sourceUrl: "https://example.com", draftId: "old", captureScope: "7",
        ownerId: "earlier", generation: 1, draft: { schemaVersion: 1, revision: 4, draftId: "old", state: oldState } },
    });
    const { result } = renderHook(() => useClipperState());
    await settled(result);
    // The page's own title, not the one the old draft kept.
    expect(result.current.title).toBe("Page");
    expect(result.current.selectedTags).toEqual([]);
    expect(result.current.selectedVault).toBe("/v");
    expect(sendToNative.mock.calls.find(([request]) => request.action === "get_status")?.[0])
      .toMatchObject({ vault_path: "/v", binding_id: "native-v" });
  });

  it("open, edit and close without Save: nothing of the clip is written to the browser (Т4)", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "No helper" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-original" });
    const { result, unmount } = renderHook(() => useClipperState());
    await settled(result);
    act(() => { result.current.setCurrentType("link"); result.current.setTitle("Edited, never saved"); result.current.toggleTag("Art"); });
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const written = vi.mocked(chrome.storage.local.set).mock.calls.flatMap(([values]) => Object.keys(values as Record<string, unknown>));
    expect(written.filter((key) => key.startsWith("mineDurable") || key.startsWith("minePendingSaveOperation:"))).toEqual([]);
    expect(JSON.stringify(await chrome.storage.local.get(null))).not.toContain("Edited, never saved");
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
  });
});
