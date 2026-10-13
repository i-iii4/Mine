import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type BrowserApiMode = "callback" | "promise";
type Message = Record<string, unknown>;
type MessageListener = (
  message: Message,
  sender: { url?: string; frameId?: number; tab?: { id: number; windowId?: number; url?: string } },
  sendResponse: (response: Message) => void,
) => boolean | undefined;

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "background.js"), "utf8");

function eventSink(register?: (listener: unknown) => void) {
  return { addListener: vi.fn((listener: unknown) => register?.(listener)) };
}

type Fetch = (url: string, init?: { credentials?: string; signal?: AbortSignal }) => Promise<unknown>;

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manifest.json"), "utf8"));

function background(apiMode: BrowserApiMode, options: {
  standaloneVault?: Record<string, unknown>; fetch?: Fetch;
  /** The build the worker's code carries, and the build the files on disk name. */
  runningBuild?: string; diskBuild?: string;
} = {}) {
  let receiveRuntimeMessage: MessageListener = () => undefined;
  const installListeners: Array<(details: { reason: string }) => void> = [];
  let receiveNativeMessage: (message: Message) => void = () => undefined;
  let disconnectNative: () => void = () => undefined;

  const createResult = { id: 17 };
  const createWindow = vi.fn((options: Message, callback?: (result: Message) => void) => {
    if (apiMode === "callback") {
      callback?.(createResult);
      return undefined;
    }
    return Promise.resolve(createResult);
  });
  const createTab = vi.fn((options: Message, callback?: (result: Message) => void) => {
    if (apiMode === "callback") {
      callback?.(createResult);
      return undefined;
    }
    return Promise.resolve(createResult);
  });
  const nativePort = {
    onMessage: eventSink((listener) => { receiveNativeMessage = listener as (message: Message) => void; }),
    onDisconnect: eventSink((listener) => { disconnectNative = listener as () => void; }),
    postMessage: vi.fn(),
  };
  const chrome = {
    action: { onClicked: eventSink() },
    commands: { onCommand: eventSink() },
    contextMenus: { onClicked: eventSink(), removeAll: vi.fn(), create: vi.fn() },
    runtime: {
      lastError: undefined as { message: string } | undefined,
      connectNative: vi.fn(() => nativePort),
      getContexts: vi.fn(async () => [] as unknown[]),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => manifest,
      reload: vi.fn(),
      onInstalled: eventSink((listener) => { installListeners.push(listener as (details: { reason: string }) => void); }),
      onMessage: eventSink((listener) => { receiveRuntimeMessage = listener as MessageListener; }),
      sendMessage: vi.fn(() => Promise.resolve()),
    },
    scripting: { executeScript: vi.fn() },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        setAccessLevel: vi.fn(() => Promise.resolve()),
      },
    },
    tabs: {
      create: createTab,
      get: vi.fn(async () => null),
      query: vi.fn(async () => [] as Array<{ id: number }>),
      sendMessage: vi.fn(),
      onRemoved: eventSink(),
    },
    windows: {
      create: createWindow,
      getAll: vi.fn(async () => [] as Array<{ id: number; tabs: Array<{ url: string }> }>),
      getCurrent: vi.fn(async () => ({ id: 1 })),
      onBoundsChanged: eventSink(),
      onRemoved: eventSink(),
      update: vi.fn(async () => undefined),
    },
  };

  // A file read answers the copy on disk; an update may have replaced it.
  // Unless a test says otherwise, it holds the build the worker runs.
  const importScripts = vi.fn();
  const runningBuild = options.runningBuild ?? "worker-build";
  const fetch = vi.fn(options.fetch ?? (async () => ({ ok: true, json: async () => ({ buildId: options.diskBuild ?? runningBuild, commit: "disk-commit" }) })));
  const context = createContext({
    AbortController,
    MineStandaloneVault: options.standaloneVault,
    TextEncoder,
    URL,
    chrome,
    console,
    crypto: { randomUUID: () => "bcb8f719-aa35-44f5-9a47-17b4d52f530f" },
    importScripts,
    // What dist/build-identity.js, the worker's first import, defines.
    MineBuildIdentity: { buildId: runningBuild, commit: "worker-commit" },
    setTimeout,
    clearTimeout,
    fetch,
  });
  runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/extensionBuild.js"), "utf8"), context);
  runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/saveProtocol.js"), "utf8"), context);
  runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/youtubeSource.js"), "utf8"), context);
  runInContext(source, context);

  function dispatch(message: Message, sender: Parameters<MessageListener>[1] = {}) {
    let resolveResponse: (response: Message) => void = () => undefined;
    const response = new Promise<Message>((resolve) => { resolveResponse = resolve; });
    const keepAlive = receiveRuntimeMessage(message, sender, resolveResponse);
    return { keepAlive, response };
  }

  return {
    chrome,
    run: (code: string): Promise<unknown> => Promise.resolve(runInContext(code, context)),
    /** The extension is installed or updated. */
    install: (reason = "install") => installListeners.forEach((listener) => listener({ reason })),
    createTab,
    createWindow,
    dispatch,
    disconnectNative,
    fetch,
    importScripts,
    nativePort,
    receiveNativeMessage: (message: Message) => receiveNativeMessage(message),
  };
}

describe.each<BrowserApiMode>(["callback", "promise"])("background messaging with %s browser APIs", (apiMode) => {
  it("removes the old drafts on install or update; save records, settings and other keys stay (Т2)", async () => {
    const worker = background(apiMode);
    worker.chrome.storage.local.get.mockResolvedValue({
      "mineDurableDraft:https://example.com": { schemaVersion: 1 },
      "mineDurableDraftRecord:capture": { schemaVersion: 2 },
      "mineDurableDraftIndex:[\"https://example.com\",\"7\"]": "capture",
      "mineDurableDraftMigration:https://example.com": "fingerprint",
      "minePendingSaveOperation:same": { id: "same" },
      mineSaveDestination: { executor: "native" },
      mineKnownVaults: ["/v"],
      popupBounds: { width: 360 },
    });
    worker.install();
    await vi.waitFor(() => expect(worker.chrome.storage.session.remove).toHaveBeenCalledWith("mineDraftBrowserSession"));
    expect(worker.chrome.storage.local.remove).toHaveBeenCalledOnce();
    expect(worker.chrome.storage.local.remove).toHaveBeenCalledWith([
      "mineDurableDraft:https://example.com",
      "mineDurableDraftRecord:capture",
      "mineDurableDraftIndex:[\"https://example.com\",\"7\"]",
      "mineDurableDraftMigration:https://example.com",
    ]);
  });
  it("removes nothing from local storage when no old draft is left", async () => {
    const worker = background(apiMode);
    worker.chrome.storage.local.get.mockResolvedValue({ mineSaveDestination: { executor: "native" } });
    worker.install();
    await vi.waitFor(() => expect(worker.chrome.storage.session.remove).toHaveBeenCalledWith("mineDraftBrowserSession"));
    expect(worker.chrome.storage.local.remove).not.toHaveBeenCalled();
  });
  it("installs the context menus when the old drafts cannot be read", async () => {
    const worker = background(apiMode);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker.chrome.storage.local.get.mockRejectedValue(new Error("storage unavailable"));
    worker.install();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[Mine] old clipper drafts kept until the next update:", "storage unavailable"));
    expect(worker.chrome.contextMenus.create).toHaveBeenCalled();
    expect(worker.chrome.storage.local.remove).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("answers openStandaloneSetup after creating its extension-origin window", async () => {
    const worker = background(apiMode);
    const request = worker.dispatch({ target: "background", action: "openStandaloneSetup", binding_id: "original" });

    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toEqual({ ok: true });
    expect(worker.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: "chrome-extension://test/dist/index.html?mode=setup&binding_id=original" }),
      expect.any(Function),
    );
  });

  it("answers openDownloadPage after creating its tab", async () => {
    const worker = background(apiMode);
    const request = worker.dispatch({ target: "background", action: "openDownloadPage" });

    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toEqual({ ok: true });
    expect(worker.createTab).toHaveBeenCalledWith(
      { url: "https://github.com/i-iii4/Mine/releases" },
      expect.any(Function),
    );
  });

  it("focuses an existing folder permission window after worker restart", async () => {
    const worker = background(apiMode);
    worker.chrome.windows.getAll.mockResolvedValue([{ id: 42, tabs: [{ url: "chrome-extension://test/dist/index.html?mode=setup" }] }]);
    await expect(worker.dispatch({ target: "background", action: "openStandaloneSetup" }).response).resolves.toEqual({ ok: true });
    expect(worker.createWindow).not.toHaveBeenCalled();
    expect(worker.chrome.windows.update).toHaveBeenCalledWith(42, { focused: true }, expect.any(Function));
  });

  it("coalesces simultaneous setup requests", async () => {
    const worker = background(apiMode);
    const first = worker.dispatch({ target: "background", action: "openStandaloneSetup" });
    const second = worker.dispatch({ target: "background", action: "openStandaloneSetup" });
    await Promise.all([first.response, second.response]);
    expect(worker.createWindow).toHaveBeenCalledOnce();
  });

  it("keeps nativeMessage open until the correlated native reply", async () => {
    const worker = background(apiMode);
    const request = worker.dispatch({ target: "background", action: "nativeMessage", payload: { action: "get_status" } });

    expect(request.keepAlive).toBe(true);
    const sent = worker.nativePort.postMessage.mock.calls[0]?.[0] as Message;
    worker.receiveNativeMessage({ ...sent, ok: false, code: "native_forbidden", error: "Access to the specified native messaging host is forbidden." });
    await expect(request.response).resolves.toMatchObject({
      ok: false,
      code: "native_forbidden",
      error: "Access to the specified native messaging host is forbidden.",
    });
  });
});

describe("background browser API failures", () => {
  it("answers when a callback-only browser API throws synchronously", async () => {
    const worker = background("callback");
    worker.createWindow.mockImplementationOnce(() => { throw new Error("window API unavailable"); });
    const request = worker.dispatch({ target: "background", action: "openStandaloneSetup" });

    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toMatchObject({ ok: false, error: "window API unavailable" });
  });

  it("answers when a Promise browser API rejects", async () => {
    const worker = background("promise");
    worker.createTab.mockRejectedValueOnce(new Error("tab API unavailable"));
    const request = worker.dispatch({ target: "background", action: "openDownloadPage" });

    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toMatchObject({ ok: false, error: "tab API unavailable" });
  });
});

// SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube».
describe("YouTube channel of a clip", () => {
  const oEmbed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=9KDDhAOyv9k")}`;
  const ask = (sourceUrl: unknown) => ({ target: "background", action: "resolveYoutubeChannel", sourceUrl });

  it("answers the channel handle oEmbed gives for the video, asked without cookies", async () => {
    const worker = background("promise", { fetch: async () => ({ ok: true, json: async () => ({
      author_name: "Kotecinho Channel", author_url: "https://www.youtube.com/@kotecinho",
    }) }) });
    const request = worker.dispatch(ask("https://youtu.be/9KDDhAOyv9k?si=tracking"));
    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toEqual({ channel: "@kotecinho" });
    expect(worker.fetch).toHaveBeenCalledWith(oEmbed, expect.objectContaining({ credentials: "omit", signal: expect.anything() }));
  });

  it("answers no channel for an address that is not a YouTube video, without a request", async () => {
    const worker = background("promise");
    await expect(worker.dispatch(ask("https://example.com/watch?v=9KDDhAOyv9k")).response).resolves.toEqual({ channel: null });
    await expect(worker.dispatch(ask(undefined)).response).resolves.toEqual({ channel: null });
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("answers no channel when oEmbed refuses the video", async () => {
    const worker = background("promise", { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    await expect(worker.dispatch(ask("https://www.youtube.com/watch?v=9KDDhAOyv9k")).response).resolves.toEqual({ channel: null });
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it("answers no channel when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const worker = background("promise", { fetch: async () => { throw new Error("offline"); } });
    await expect(worker.dispatch(ask("https://www.youtube.com/watch?v=9KDDhAOyv9k")).response).resolves.toEqual({ channel: null });
    expect(warn).toHaveBeenCalledWith("[Mine] YouTube channel unavailable:", "offline");
    warn.mockRestore();
  });

  it("gives up after the bound and answers no channel", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const worker = background("promise", {
        fetch: (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      });
      const settled = vi.fn();
      const answered = worker.dispatch(ask("https://www.youtube.com/watch?v=9KDDhAOyv9k")).response.then(settled);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await answered;
      expect(settled).toHaveBeenCalledWith({ channel: null });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("widget and background compatibility", () => {
  it("accepts an older widget through the retained baseline, independently of build identity", async () => {
    const worker = background("promise");
    const request = worker.dispatch({ target: "background", action: "clipperHandshake", build_id: "old-widget", save_protocols: [1] });
    await expect(request.response).resolves.toMatchObject({ ok: true, save_protocols: [1], build_id: "worker-build", commit: "worker-commit" });
    expect(worker.nativePort.postMessage).not.toHaveBeenCalled();
  });

  it("names the build of the running worker, not of the copy on disk (К4)", async () => {
    const worker = background("promise", { diskBuild: "disk-build" });
    expect(worker.importScripts.mock.calls[0]?.[0]).toBe("dist/build-identity.js");
    const request = worker.dispatch({ target: "background", action: "clipperHandshake", save_protocols: [1] });
    await expect(request.response).resolves.toMatchObject({ build_id: "worker-build", commit: "worker-commit" });
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unsupported widget before native calls", async () => {
    const worker = background("promise");
    const request = worker.dispatch({ target: "background", action: "clipperHandshake", save_protocols: [9] });
    await expect(request.response).resolves.toMatchObject({ ok: false, code: "incompatible_protocol" });
    expect(worker.nativePort.postMessage).not.toHaveBeenCalled();
  });
  it("rejects unsupported mandatory widget capabilities before native calls", async () => {
    const worker = background("promise");
    const request = worker.dispatch({ target: "background", action: "clipperHandshake", save_protocols: [1], required_capabilities: ["future_required"] });
    await expect(request.response).resolves.toMatchObject({ ok: false, code: "incompatible_protocol" });
    expect(worker.nativePort.postMessage).not.toHaveBeenCalled();
  });
});

// SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 8.
describe("the post of an X feed is read only for X itself", () => {
  const post = { id: "2108558741528355242", text: "Main text" };
  function xWorker() {
    const worker = background("promise");
    worker.chrome.scripting.executeScript.mockResolvedValue([{ result: post }]);
    return worker;
  }
  const read = (worker: ReturnType<typeof background>, sender: Parameters<MessageListener>[1], tweetId: unknown = post.id) =>
    worker.dispatch({ target: "background", action: "readXPost", tweetId }, sender);

  it.each([
    "https://x.com/i/lists/2015212000000000000",
    "https://x.com/home",
    "https://twitter.com/search?q=mine",
    "https://pro.x.com/i/decks/1840000000000000000",
  ])("reads the post in the MAIN world of the top frame of %s", async (url) => {
    const worker = xWorker();
    const request = read(worker, { url, frameId: 0, tab: { id: 4 } });
    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toEqual({ post });
    const [injection] = worker.chrome.scripting.executeScript.mock.calls[0] as [Record<string, unknown>];
    expect(injection).toMatchObject({ target: { tabId: 4, frameIds: [0] }, world: "MAIN", args: [post.id] });
  });

  it.each([
    [{ url: "https://example.com/x.com/home", frameId: 0, tab: { id: 4 } }, post.id],
    [{ url: "https://x.com.example.com/home", frameId: 0, tab: { id: 4 } }, post.id],
    [{ url: "http://x.com/home", frameId: 0, tab: { id: 4 } }, post.id],
    [{ url: "https://x.com/home", frameId: 3, tab: { id: 4 } }, post.id],
    [{ url: "https://x.com/home", frameId: 0 }, post.id],
    [{ url: "https://x.com/home", frameId: 0, tab: { id: 4 } }, "1; alert(1)"],
    [{ url: "https://x.com/home", frameId: 0, tab: { id: 4 } }, 2108558741528355242],
  ])("answers no post to %j asking for %j, without touching the page", async (sender, tweetId) => {
    const worker = xWorker();
    const request = read(worker, sender, tweetId);
    await expect(request.response).resolves.toEqual({ post: null });
    expect(worker.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("answers no post when the page has no observer yet or the injection fails", async () => {
    const worker = xWorker();
    worker.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: null }]);
    await expect(read(worker, { url: "https://x.com/home", frameId: 0, tab: { id: 4 } }).response).resolves.toEqual({ post: null });
    worker.chrome.scripting.executeScript.mockRejectedValueOnce(new Error("Frame with ID 0 was removed."));
    await expect(read(worker, { url: "https://x.com/home", frameId: 0, tab: { id: 4 } }).response).resolves.toEqual({ post: null });
  });

  it("still collects a thread only on the page of that post, X Pro included", async () => {
    const worker = xWorker();
    worker.chrome.scripting.executeScript.mockResolvedValue([{ result: { posts: [post], issues: [] } }]);
    const collect = (url: string) => worker.dispatch({ target: "background", action: "collectXThread", tweetId: post.id },
      { url, frameId: 0, tab: { id: 4 } }).response;
    await expect(collect("https://x.com/home")).resolves.toMatchObject({ posts: [] });
    await expect(collect(`https://pro.x.com/artignatev/status/${post.id}`)).resolves.toMatchObject({ posts: [post] });
  });
});

// SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 6: the service answers only
// https://platform.twitter.com, so the content script and the overlay, which
// go with the page's origin, ask background (13.10.2026).
describe("the syndication answer of an X post", () => {
  const id = "2108700000000000001";
  const service = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=0`;
  const ask = (tweetId: unknown) => ({ target: "background", action: "readXSyndication", tweetId });
  const sender = { url: "https://x.com/home", frameId: 0, tab: { id: 4 } };

  it("asks the service by the ID without cookies and answers its data", async () => {
    const data = { __typename: "Tweet", id_str: id, text: "Fallback text", mediaDetails: [] };
    const worker = background("promise", { fetch: async () => ({ ok: true, json: async () => data }) });
    const request = worker.dispatch(ask(id), sender);
    expect(request.keepAlive).toBe(true);
    await expect(request.response).resolves.toEqual({ ok: true, data });
    expect(worker.fetch).toHaveBeenCalledWith(service, expect.objectContaining({ credentials: "omit", signal: expect.anything() }));
  });

  it.each([["1; alert(1)"], [Number(id)], [undefined], ["1".repeat(26)]])("asks nothing for the ID %j", async (tweetId) => {
    const worker = background("promise");
    await expect(worker.dispatch(ask(tweetId), sender).response).resolves.toEqual({ ok: false });
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("answers no data when the service refuses the post or answers no object", async () => {
    const refused = background("promise", { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    await expect(refused.dispatch(ask(id), sender).response).resolves.toEqual({ ok: false, status: 404 });
    const odd = background("promise", { fetch: async () => ({ ok: true, json: async () => [] }) });
    await expect(odd.dispatch(ask(id), sender).response).resolves.toEqual({ ok: false });
  });

  it("answers no data when the request fails, and gives up after the bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const offline = background("promise", { fetch: async () => { throw new Error("offline"); } });
      await expect(offline.dispatch(ask(id), sender).response).resolves.toEqual({ ok: false });
      expect(warn).toHaveBeenCalledWith("[Mine] X post unavailable from syndication:", "offline");
      const silent = background("promise", {
        fetch: (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      });
      const settled = vi.fn();
      const answered = silent.dispatch(ask(id), sender).response.then(settled);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await answered;
      expect(settled).toHaveBeenCalledWith({ ok: false });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe("a clipper opening belongs to its source tab (SPEC_AUDIT_FIXES.md, Ф6)", () => {
  function launchWorker() {
    const worker = background("promise");
    const session: Record<string, unknown> = {};
    // Like the browser's storage: every read is a copy, so a change is seen
    // only once it is written back.
    worker.chrome.storage.session.get.mockImplementation(async (key: unknown) => ({ [key as string]: structuredClone(session[key as string]) }));
    worker.chrome.storage.session.set.mockImplementation(async (values: unknown) => { Object.assign(session, structuredClone(values)); });
    worker.chrome.storage.session.remove.mockImplementation(async (keys: unknown) => {
      for (const key of [keys].flat() as string[]) delete session[key];
    });
    return worker;
  }
  const ask = (worker: ReturnType<typeof background>, sender: { url?: string; tab?: { id: number; windowId?: number } }) =>
    worker.dispatch({ target: "background", action: "getClipperLaunch" }, sender).response;

  it("hands the context-menu target only to the clipper of its tab, and once", async () => {
    const worker = launchWorker();
    await worker.run(`recordClipperLaunch({ id: 5, url: "https://a.example/", title: "A" },
      { contextMenu: { menuItemId: "save-image", srcUrl: "https://a.example/i.jpg" } })`);
    await expect(ask(worker, { url: "https://b.example/", tab: { id: 6 } })).resolves.toBeNull();
    await expect(ask(worker, { url: "https://a.example/", tab: { id: 5 } }))
      .resolves.toMatchObject({ sourceTabId: 5, contextMenu: { srcUrl: "https://a.example/i.jpg" } });
    await expect(ask(worker, { url: "https://a.example/", tab: { id: 5 } }))
      .resolves.toMatchObject({ sourceTabId: 5, contextMenu: null });
  });

  it("gives the clipper window the tab it was opened for, not its own", async () => {
    const worker = launchWorker();
    await worker.run(`recordClipperLaunch({ id: 5, url: "https://a.example/", title: "A" }, {})`);
    await worker.run("rememberClipperWindowSource(77, 5)");
    await expect(ask(worker, { url: "chrome-extension://test/dist/index.html", tab: { id: 900, windowId: 77 } }))
      .resolves.toMatchObject({ sourceTabId: 5, sourceUrl: "https://a.example/", sourceTitle: "A" });
  });

  it("does not keep an Instagram post for a clipper that never opened", async () => {
    const worker = launchWorker();
    worker.chrome.tabs.sendMessage.mockImplementation((_id: unknown, _message: unknown, callback?: (r: unknown) => void) => { callback?.(undefined); });
    const tab = { id: 5, url: "https://www.instagram.com/p/abc/" };
    const opened = await worker.dispatch({ target: "background", action: "showOverlayInThisTab", pageUrl: tab.url,
      preloaded: { metadata: { url: tab.url }, article: { content: "Post" } } }, { url: tab.url, tab }).response;
    expect(opened).toMatchObject({ ok: false });
    await expect(ask(worker, { url: tab.url, tab })).resolves.toBeNull();
  });

  it("captures the source tab only while it is in front of its window", async () => {
    const worker = launchWorker();
    const chrome = worker.chrome as unknown as { tabs: Record<string, ReturnType<typeof vi.fn>> };
    chrome.tabs.sendMessage.mockImplementation((_id: unknown, _message: unknown, callback?: (r: unknown) => void) => { callback?.({ ok: true }); });
    chrome.tabs.captureVisibleTab = vi.fn((_windowId: unknown, _options: unknown, callback: (url: string) => void) => callback("data:image/jpeg;base64,AA"));
    const fromWindow = { url: "chrome-extension://test/dist/index.html", tab: { id: 900, windowId: 77 } };
    const page = "https://a.example/";
    const capture = () => worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5 }, fromWindow).response;

    chrome.tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: false, url: page });
    await expect(capture()).resolves.toMatchObject({ ok: false });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();

    chrome.tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: page });
    chrome.tabs.query.mockResolvedValue([{ id: 6, url: "https://other.example/" }]);
    await expect(capture()).resolves.toMatchObject({ ok: false });
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(3, expect.anything(), expect.any(Function));

    chrome.tabs.query.mockResolvedValue([{ id: 5, url: page }]);
    await expect(capture()).resolves.toMatchObject({ ok: true, dataUrl: "data:image/jpeg;base64,AA" });
  });

  describe("a screenshot takes the page the tab shows now (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р9)", () => {
    const pageA = "https://a.example/story";
    const pageB = "https://b.example/other";
    const fromWindow = { url: "chrome-extension://test/dist/index.html", tab: { id: 900, windowId: 77 } };
    function captureWorker() {
      const worker = launchWorker();
      const chrome = worker.chrome as unknown as { tabs: Record<string, ReturnType<typeof vi.fn>> };
      chrome.tabs.sendMessage.mockImplementation((_id: unknown, _message: unknown, callback?: (r: unknown) => void) => { callback?.({ ok: true }); });
      chrome.tabs.captureVisibleTab = vi.fn((_windowId: unknown, _options: unknown, callback: (url: string) => void) => callback("data:image/jpeg;base64,AA"));
      return { worker, tabs: chrome.tabs };
    }

    it("captures page B for the window whose source tab moved from A to B", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageB });
      tabs.query.mockResolvedValue([{ id: 5, url: pageB }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5 }, fromWindow).response;
      expect(reply).toMatchObject({ ok: true, dataUrl: "data:image/jpeg;base64,AA" });
    });

    it("captures the page the overlay's tab shows after its address changed in place", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageB });
      tabs.query.mockResolvedValue([{ id: 5, url: pageB }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop" }, { url: pageB, tab: { id: 5 } }).response;
      expect(reply).toMatchObject({ ok: true });
      expect(tabs.captureVisibleTab).toHaveBeenCalledOnce();
    });

    // SPEC_DEEP_AUDIT.md, Е3.13: the page hides its Mine buttons for the frame
    // and shows them again once the frame is taken, whatever came of it.
    it("tells the page the frame is taken after it asked it to prepare", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageA });
      tabs.query.mockResolvedValue([{ id: 5, url: pageA }]);
      await worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5 }, fromWindow).response;
      const asked = tabs.sendMessage.mock.calls.map(([id, message]) => [id, (message as { action: string }).action]);
      expect(asked).toEqual([[5, "prepareViewportCapture"], [5, "finishViewportCapture"]]);
    });

    it("drops a frame taken while the page moved away", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageA });
      tabs.query.mockResolvedValue([{ id: 5, url: pageB }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5 }, fromWindow).response;
      expect(reply).toMatchObject({ ok: false, error: "The page changed while the screenshot was taken. Retake it." });
      expect(reply).not.toHaveProperty("dataUrl");
    });

    // A Save link clip takes the page shown too (12.10.2026). A clipper of an
    // earlier build still names the link; the address is not read.
    it("captures the page shown for a Save link clip, whatever address the request names", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageA });
      tabs.query.mockResolvedValue([{ id: 5, url: pageA }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5, documentUrl: pageB }, fromWindow).response;
      expect(reply).toMatchObject({ ok: true, dataUrl: "data:image/jpeg;base64,AA" });
      expect(tabs.captureVisibleTab).toHaveBeenCalledOnce();
    });
  });

  describe("a crop from the clipper window runs in its source tab (Б4.7)", () => {
    const page = "https://a.example/story";
    const fromWindow = { url: "chrome-extension://test/dist/index.html", tab: { id: 900, windowId: 77 } };
    function cropWorker(tabUrl: string) {
      const worker = launchWorker();
      const chrome = worker.chrome as unknown as { tabs: Record<string, ReturnType<typeof vi.fn>> };
      chrome.tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: tabUrl });
      chrome.tabs.sendMessage.mockImplementation((_id: unknown, _message: unknown, callback?: (r: unknown) => void) => { callback?.({ ok: true }); });
      return { worker, tabs: chrome.tabs };
    }

    it("asks the page the window opened for, not the window's own tab", async () => {
      const { worker, tabs } = cropWorker(page);
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: 5 }, fromWindow).response;
      expect(reply).toEqual({ ok: true });
      expect(tabs.sendMessage).toHaveBeenCalledWith(5, { action: "startCropOverlay", cropId: null }, expect.any(Function));
      expect(tabs.sendMessage).not.toHaveBeenCalledWith(900, expect.anything(), expect.anything());
    });

    it("starts the crop on the page the source tab shows now (Р9)", async () => {
      const { worker, tabs } = cropWorker("https://b.example/other");
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: 5 }, fromWindow).response;
      expect(reply).toEqual({ ok: true });
      expect(tabs.sendMessage).toHaveBeenCalledWith(5, expect.objectContaining({ action: "startCropOverlay" }), expect.any(Function));
    });

    it("starts the crop of a Save link clip on the page shown, whatever address the request names (12.10.2026)", async () => {
      const { worker, tabs } = cropWorker("https://b.example/other");
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: 5, documentUrl: page }, fromWindow).response;
      expect(reply).toEqual({ ok: true });
      expect(tabs.sendMessage).toHaveBeenCalledWith(5, { action: "startCropOverlay", cropId: null }, expect.any(Function));
    });

    it("keeps an overlay's crop in the overlay's own tab, under the overlay's crop id (Г3.3)", async () => {
      const { worker, tabs } = cropWorker(page);
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: -1, cropId: "crop-1" }, { url: page, tab: { id: 5 } }).response;
      expect(reply).toEqual({ ok: true });
      expect(tabs.sendMessage).toHaveBeenCalledWith(5, { action: "startCropOverlay", cropId: "crop-1" }, expect.any(Function));
    });
  });

  describe("the clip of an open overlay waits for the next document of its tab (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч12)", () => {
    const pageA = "https://a.example/story";
    const pageB = "https://b.example/other";
    const fromPage = (url: string, tabId = 5) => ({ url, frameId: 0, tab: { id: tabId, url } });
    const shot = { dataUrl: "data:image/jpeg;base64,AA", uploadId: "shot-1" };
    const clip = (title: string, extra: Record<string, unknown> = {}) => ({
      version: 1, pageUrl: pageA, metadata: { url: pageA, title, selection: "", detectedType: "link" }, articleData: null,
      articleExtractionState: "idle", launchedArticle: null, linkTarget: null, title, selectedTags: ["Design"],
      currentType: "screenshot", destination: { executor: "native", vaultPath: "/v", bindingId: "b", label: "/v" },
      edited: true, ...extra,
    });
    const write = (worker: ReturnType<typeof background>, value: unknown, sender = fromPage(pageA)) =>
      worker.dispatch({ target: "background", action: "openClipWrite", clip: value }, sender).response;
    const stored = (worker: ReturnType<typeof background>, tabId = 5) =>
      worker.run(`readOpenClip(${tabId})`) as Promise<Record<string, unknown> | null>;

    it("keeps the clip under its tab, and the frame it was sent with until a new one comes", async () => {
      const worker = launchWorker();
      await expect(write(worker, clip("First", { screenshot: shot }))).resolves.toEqual({ ok: true });
      await expect(write(worker, clip("Second"))).resolves.toEqual({ ok: true });
      await expect(stored(worker)).resolves.toMatchObject({ title: "Second", screenshot: shot });
      await write(worker, clip("Third", { screenshot: null }));
      await expect(stored(worker)).resolves.toMatchObject({ title: "Third", screenshot: null });
      await expect(stored(worker, 6)).resolves.toBeNull();
    });

    it("takes a clip only from the top frame of a page tab, and only one it can open", async () => {
      const worker = launchWorker();
      await expect(write(worker, clip("Frame"), { ...fromPage(pageA), frameId: 3 })).resolves.toEqual({ ok: false });
      await expect(write(worker, clip("Window"), { url: "chrome-extension://test/dist/index.html", frameId: 0, tab: { id: 5, url: "x" } }))
        .resolves.toEqual({ ok: false });
      await expect(write(worker, { ...clip("Old"), version: 0 })).resolves.toEqual({ ok: false });
      await expect(stored(worker)).resolves.toBeNull();
    });

    it("forgets the clip when the overlay closes or saves, and when its tab closes", async () => {
      const worker = launchWorker();
      await write(worker, clip("Open"));
      await expect(worker.dispatch({ target: "background", action: "openClipClear" }, fromPage(pageB)).response).resolves.toEqual({ ok: true });
      await expect(stored(worker)).resolves.toBeNull();
      await write(worker, clip("Open again"));
      const removed = worker.chrome.tabs.onRemoved.addListener.mock.calls.map(([listener]) => listener as (tabId: number) => void);
      removed.forEach((listener) => listener(5));
      await vi.waitFor(async () => expect(await stored(worker)).toBeNull());
      await expect(worker.run("anyOpenClip()")).resolves.toBe(false);
    });

    it("opens the overlay of a new document with the kept clip, by the icon's delivery", async () => {
      const worker = launchWorker();
      await write(worker, clip("Kept", { screenshot: shot }));
      const shown: unknown[] = [];
      worker.chrome.tabs.sendMessage.mockImplementation((_id: unknown, message: unknown, callback?: (r: unknown) => void) => {
        shown.push(message);
        callback?.(shown.length === 1 ? undefined : { ok: true });
      });
      const reply = await worker.dispatch({ target: "background", action: "restoreOpenClip" }, fromPage(pageB)).response;
      expect(reply).toEqual({ ok: true, mode: "overlay" });
      expect(worker.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 5 }, files: ["dist/overlay.js"] });
      expect(shown.at(-1)).toMatchObject({ action: "showClipperOverlay", freshMaterial: false,
        restore: { title: "Kept", pageUrl: pageA, screenshot: shot } });
    });

    it("opens nothing in a tab without a kept clip", async () => {
      const worker = launchWorker();
      await write(worker, clip("Other tab"), fromPage(pageA, 6));
      const reply = await worker.dispatch({ target: "background", action: "restoreOpenClip" }, fromPage(pageB)).response;
      expect(reply).toEqual({ ok: false, mode: "none" });
      expect(worker.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    // Session storage holds 10 MB and refuses a write past that whole, with
    // its own words (Chromium 148 without a window, 13.10.2026). The editor
    // learns what was not kept (SPEC_DEEP_AUDIT.md, Е3.11).
    function quotaWorker() {
      const worker = launchWorker();
      const session: Record<string, unknown> = {};
      const bytes = (values: Record<string, unknown>) => Object.entries(values)
        .reduce((total, [key, value]) => total + key.length + JSON.stringify(value).length, 0);
      worker.chrome.storage.session.get.mockImplementation(async (key: unknown) => ({ [key as string]: structuredClone(session[key as string]) }));
      worker.chrome.storage.session.set.mockImplementation(async (values: Record<string, unknown>) => {
        if (bytes({ ...session, ...values }) > 10_485_760) throw new Error("Session storage quota bytes exceeded. Values were not stored.");
        Object.assign(session, structuredClone(values));
      });
      worker.chrome.storage.session.remove.mockImplementation(async (keys: unknown) => {
        for (const key of [keys].flat() as string[]) delete session[key];
      });
      return worker;
    }
    const big = "A".repeat(11 * 1024 * 1024);

    it("keeps a clip too large with its frame without the frame, and says so", async () => {
      const worker = quotaWorker();
      const reply = await write(worker, clip("Large frame", { screenshot: { dataUrl: `data:image/jpeg;base64,${big}`, uploadId: "shot-big" } }));
      expect(reply).toEqual({ ok: true, screenshotKept: false });
      await expect(stored(worker)).resolves.toMatchObject({ title: "Large frame", screenshot: null });
    });

    it("keeps no older copy of a clip it cannot hold, and says the clip is not kept", async () => {
      const worker = quotaWorker();
      await expect(write(worker, clip("Small"))).resolves.toEqual({ ok: true });
      const reply = await write(worker, clip("Long article", {
        articleData: { title: "Long article", content: big, byline: null, excerpt: "" }, articleExtractionState: "ready",
      }));
      expect(reply).toMatchObject({ ok: false, code: "open_clip_too_large" });
      await expect(stored(worker)).resolves.toBeNull();
      await expect(worker.run("anyOpenClip()")).resolves.toBe(false);
    });

    it("counts a kept clip as an open clipper for a pending update (К4)", async () => {
      const worker = launchWorker();
      await expect(worker.run("anyEditorOpen()")).resolves.toBe(false);
      await write(worker, clip("Open"));
      await expect(worker.run("anyEditorOpen()")).resolves.toBe(true);
    });
  });

  describe("launch records survive simultaneous events (Б4.8)", () => {
    it("keeps both launches when two tabs open the clipper at once", async () => {
      const worker = launchWorker();
      await worker.run(`Promise.all([
        recordClipperLaunch({ id: 5, url: "https://a.example/" }, { contextMenu: { menuItemId: "save-image", srcUrl: "https://a.example/i.jpg" } }),
        recordClipperLaunch({ id: 6, url: "https://b.example/" }, { preloaded: { metadata: { url: "https://b.example/" } } }),
      ])`);
      await expect(ask(worker, { url: "https://a.example/", tab: { id: 5 } }))
        .resolves.toMatchObject({ sourceTabId: 5, contextMenu: { srcUrl: "https://a.example/i.jpg" } });
      await expect(ask(worker, { url: "https://b.example/", tab: { id: 6 } }))
        .resolves.toMatchObject({ sourceTabId: 6, preloaded: { metadata: { url: "https://b.example/" } } });
    });

    it("keeps a new launch when another tab closes at the same moment", async () => {
      const worker = launchWorker();
      await worker.run(`recordClipperLaunch({ id: 6, url: "https://b.example/" }, {})`);
      await worker.run(`Promise.all([
        recordClipperLaunch({ id: 5, url: "https://a.example/" }, { contextMenu: { menuItemId: "save-page" } }),
        forgetClipperLaunch(6),
      ])`);
      await expect(ask(worker, { url: "https://a.example/", tab: { id: 5 } }))
        .resolves.toMatchObject({ sourceTabId: 5, contextMenu: { menuItemId: "save-page" } });
      await expect(ask(worker, { url: "https://b.example/", tab: { id: 6 } })).resolves.toBeNull();
    });

    it("keeps both clipper windows when two open at once", async () => {
      const worker = launchWorker();
      await worker.run("Promise.all([rememberClipperWindowSource(77, 5), rememberClipperWindowSource(78, 6), rememberPopupWindow(77), rememberPopupWindow(78)])");
      await expect(worker.run("Promise.all([isOurPopup(77), isOurPopup(78)])")).resolves.toEqual([true, true]);
      await worker.run(`Promise.all([recordClipperLaunch({ id: 5, url: "https://a.example/" }, {}), recordClipperLaunch({ id: 6, url: "https://b.example/" }, {})])`);
      await expect(ask(worker, { url: "chrome-extension://test/dist/index.html", tab: { id: 901, windowId: 78 } }))
        .resolves.toMatchObject({ sourceTabId: 6 });
    });
  });

  describe("a repeated launch keeps the open clip (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч11)", () => {
    it("tells the overlay whether the launch brings new material", async () => {
      const worker = launchWorker();
      const shown: Message[] = [];
      const tabs = worker.chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
      tabs.mockImplementation((_tabId: number, message: Message, reply?: (response: unknown) => void) => {
        if (message.action !== "showClipperOverlay") return;
        shown.push(message);
        reply?.({ ok: true });
      });
      const page = JSON.stringify({ id: 5, url: "https://a.example/", title: "A" });
      await expect(worker.run(`openClipperUi(${page})`)).resolves.toBe("overlay");
      await expect(worker.run(`openClipperUi(${page}, { contextMenu: { menuItemId: "save-image", srcUrl: "https://a.example/i.jpg" } })`))
        .resolves.toBe("overlay");
      expect(shown.map((message) => message.freshMaterial)).toEqual([false, true]);
    });

    it("brings the clipper window of the tab forward instead of opening another", async () => {
      const worker = launchWorker();
      const page = JSON.stringify({ id: 5, url: "chrome://extensions/", title: "Extensions" });
      await expect(worker.run(`openClipperUi(${page})`)).resolves.toBe("window");
      expect(worker.createWindow).toHaveBeenCalledOnce();

      await expect(worker.run(`openClipperUi(${page})`)).resolves.toBe("window");
      expect(worker.createWindow).toHaveBeenCalledOnce();
      expect(worker.chrome.windows.update).toHaveBeenCalledWith(17, { focused: true });
    });

    it("opens a new window for a launch with new material", async () => {
      const worker = launchWorker();
      const page = JSON.stringify({ id: 5, url: "chrome://extensions/", title: "Extensions" });
      await worker.run(`openClipperUi(${page})`);
      await worker.run(`openClipperUi(${page}, { contextMenu: { menuItemId: "save-link", linkUrl: "https://b.example/" } })`);
      expect(worker.createWindow).toHaveBeenCalledTimes(2);
    });

    it("opens a new window when the tab's window is gone", async () => {
      const worker = launchWorker();
      const page = JSON.stringify({ id: 5, url: "chrome://extensions/", title: "Extensions" });
      await worker.run(`openClipperUi(${page})`);
      worker.chrome.windows.update.mockRejectedValueOnce(new Error("No window with id: 17."));
      await expect(worker.run(`openClipperUi(${page})`)).resolves.toBe("window");
      expect(worker.createWindow).toHaveBeenCalledTimes(2);
    });
  });

  describe("two openings of one tab (SPEC_AUDIT_FIXES.md, Г3.1)", () => {
    /// A tab whose overlay script answers only once it has been injected; the
    /// injection finishes when the test says so.
    function tabWithoutOverlay() {
      const worker = launchWorker();
      const chrome = worker.chrome as unknown as {
        runtime: { lastError: { message: string } | undefined };
        scripting: { executeScript: ReturnType<typeof vi.fn> };
        tabs: Record<string, ReturnType<typeof vi.fn>>;
      };
      let injected = false;
      const injections: Array<() => void> = [];
      chrome.scripting.executeScript.mockImplementation(() => new Promise<void>((resolve) => {
        injections.push(() => { injected = true; resolve(); });
      }));
      const shows: number[] = [];
      chrome.tabs.sendMessage.mockImplementation((tabId: number, message: Message, reply?: (response: unknown) => void) => {
        if (message.action !== "showClipperOverlay") return;
        if (!injected) {
          chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
          reply?.(undefined);
          chrome.runtime.lastError = undefined;
          return;
        }
        shows.push(tabId);
        reply?.({ ok: true });
      });
      return { worker, executeScript: chrome.scripting.executeScript, injections, shows };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("injects the overlay once when the second opening comes before the first injection finished", async () => {
      const tab = tabWithoutOverlay();
      const page = JSON.stringify({ id: 5, url: "https://a.example/", title: "A" });
      const first = tab.worker.run(`openClipperUi(${page})`);
      const second = tab.worker.run(`openClipperUi(${page})`);
      await vi.waitFor(() => expect(tab.executeScript).toHaveBeenCalled());
      await settle();
      expect(tab.executeScript).toHaveBeenCalledTimes(1);

      tab.injections.forEach((finish) => finish());
      await expect(first).resolves.toBe("overlay");
      await expect(second).resolves.toBe("overlay");
      expect(tab.executeScript).toHaveBeenCalledTimes(1);
      // Both openings reach the one overlay: the second reuses its editor.
      expect(tab.shows).toEqual([5, 5]);
    });

    it("does not hold an opening of another tab behind it", async () => {
      const tab = tabWithoutOverlay();
      void tab.worker.run(`openClipperUi(${JSON.stringify({ id: 5, url: "https://a.example/" })})`);
      void tab.worker.run(`openClipperUi(${JSON.stringify({ id: 6, url: "https://b.example/" })})`);
      await vi.waitFor(() => expect(tab.executeScript).toHaveBeenCalledTimes(2));
      expect(tab.executeScript.mock.calls.map(([options]) => (options as { target: { tabId: number } }).target.tabId)).toEqual([5, 6]);
    });
  });
});

describe("an extension update checks again right before the reload (SPEC_AUDIT_FIXES.md, В4.6)", () => {
  afterEach(() => vi.useRealTimers());

  const sourceUrl = "https://example.com/story";
  const tab = { id: 7 };

  /// The actual worker with an update waiting and a browser folder whose
  /// writes the test finishes itself.
  function updatingWorker() {
    vi.useFakeTimers();
    let finishWrite: () => void = () => undefined;
    const standaloneVault = {
      saveStandaloneBlock: () => new Promise((resolve) => { finishWrite = () => resolve({ ok: true }); }),
    };
    const worker = background("promise", { standaloneVault });
    const local = new Map<string, unknown>();
    const session = new Map<string, unknown>([["mineReloadPending", "new-build"]]);
    const read = (store: Map<string, unknown>, key: unknown) => key === null
      ? Object.fromEntries([...store].map(([name, value]) => [name, structuredClone(value)]))
      : { [key as string]: structuredClone(store.get(key as string)) };
    const storage = worker.chrome.storage as unknown as Record<"local" | "session", Record<string, ReturnType<typeof vi.fn>>>;
    storage.local.get.mockImplementation(async (key: unknown) => read(local, key));
    storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(values)) local.set(name, structuredClone(value));
    });
    storage.session.get.mockImplementation(async (key: unknown) => read(session, key));
    storage.session.set.mockImplementation(async (values: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(values)) session.set(name, structuredClone(value));
    });
    storage.session.remove.mockImplementation(async (name: string) => { session.delete(name); });
    const send = (message: Message, sender: { tab?: { id: number; url?: string } } = { tab }) =>
      worker.dispatch({ target: "background", sourceUrl, ...message }, sender).response;
    return { worker, session, send, finishWrite: () => finishWrite() };
  }

  /// The update check that a clipper's Escape starts, held while it asks the
  /// browser for open extension pages.
  async function checkHeldAtPages(host: ReturnType<typeof updatingWorker>) {
    let answerPages: (pages: unknown[]) => void = () => undefined;
    host.worker.chrome.runtime.getContexts.mockImplementationOnce(() => new Promise((resolve) => { answerPages = resolve; }));
    host.worker.dispatch({ target: "background", action: "mineClipperClosed" }, { tab });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.worker.chrome.runtime.getContexts).toHaveBeenCalledOnce();
    return (pages: unknown[]) => answerPages(pages);
  }

  it("does not reload while a browser-folder save that began during the check is still being written", async () => {
    const host = updatingWorker();
    const answerPages = await checkHeldAtPages(host);

    const written = host.send({ action: "standaloneSave", payload: { title: "Saved during the check" } });
    answerPages([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.worker.chrome.runtime.reload).not.toHaveBeenCalled();
    expect(host.session.get("mineReloadPending")).toBe("new-build");

    host.finishWrite();
    await expect(written).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.worker.chrome.runtime.reload).toHaveBeenCalledOnce();
  });

  it("keeps a clipper that opened after its tab answered the check, until it closes", async () => {
    const host = updatingWorker();
    const other = { id: 9, url: "https://c.example/post" };
    let overlayOpen = false;
    let answerTab: ((answer: { open: boolean }) => void) | null = null;
    host.worker.chrome.tabs.query.mockResolvedValue([other]);
    const tabs = host.worker.chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    tabs.mockImplementation((_id: number, message: Message, reply?: unknown) => {
      if (message.action === "showClipperOverlay" && typeof reply === "function") {
        overlayOpen = true;
        reply({ ok: true });
        return undefined;
      }
      if (message.action !== "mineClipperIsOpen") return undefined;
      // The first answer is the one the tab gave before the clipper opened.
      if (answerTab === null) return new Promise((resolve) => { answerTab = resolve; });
      return Promise.resolve({ open: overlayOpen });
    });
    const answerPages = await checkHeldAtPages(host);
    answerPages([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(answerTab).not.toBeNull();

    // The clip button of the page in tab 9 opens the clipper meanwhile.
    await expect(host.send({ action: "showOverlayInThisTab", pageUrl: other.url }, { tab: other }))
      .resolves.toMatchObject({ ok: true, mode: "overlay" });
    answerTab!({ open: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.worker.chrome.runtime.reload).not.toHaveBeenCalled();

    overlayOpen = false;
    host.worker.dispatch({ target: "background", action: "mineClipperClosed" }, { tab: other });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.worker.chrome.runtime.reload).toHaveBeenCalledOnce();
  });
});

// SPEC_CLIPPER.md, К4: what the worker reads from disk is of its own build,
// and the pages open before its build get its content scripts.
describe("files of the running build and the pages open before it (К4)", () => {
  afterEach(() => vi.useRealTimers());

  type Tab = { id: number; url: string; title?: string; discarded?: boolean };
  type Groups = Array<{ js: string[]; world?: string }>;
  const groups = manifest.content_scripts as Groups;
  const contentScripts = groups.find((group) => group.js.includes("content.js"))!.js;
  const instagramOverlay = groups.find((group) => group.js.includes("dist/overlay.js"))!.js;
  const pageWorld = groups.find((group) => group.world === "MAIN")!.js;

  /// A match pattern of the manifest as a test of an address.
  function matches(pattern: string, url: string) {
    return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(url);
  }

  /// The actual worker of `runningBuild` over files of `diskBuild`. Local
  /// storage outlives the reload; session storage is the worker's own. An
  /// overlay answers in a tab once dist/overlay.js was put there. The tabs of
  /// `pageCaches` run the post cache of X in their page world.
  function worker(runningBuild: string, diskBuild: string, local: Map<string, unknown>, tabs: Tab[],
    pageCaches = new Set<number>()) {
    const host = background("promise", { runningBuild, diskBuild });
    const session = new Map<string, unknown>();
    const storage = host.chrome.storage as unknown as Record<"local" | "session", Record<string, ReturnType<typeof vi.fn>>>;
    for (const [area, store] of [["local", local], ["session", session]] as const) {
      storage[area].get.mockImplementation(async (key: unknown) => key === null
        ? Object.fromEntries([...store].map(([name, value]) => [name, structuredClone(value)]))
        : { [key as string]: structuredClone(store.get(key as string)) });
      storage[area].set.mockImplementation(async (values: Record<string, unknown>) => {
        for (const [name, value] of Object.entries(values)) store.set(name, structuredClone(value));
      });
      storage[area].remove.mockImplementation(async (keys: unknown) => {
        for (const name of [keys].flat() as string[]) store.delete(name);
      });
    }
    const chrome = host.chrome as unknown as {
      runtime: { lastError: { message: string } | undefined };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
      tabs: Record<string, ReturnType<typeof vi.fn>>;
    };
    chrome.tabs.query.mockImplementation(async (query: { url?: string[] }) =>
      tabs.filter((tab) => !query.url || query.url.some((pattern) => matches(pattern, tab.url))));
    chrome.tabs.get.mockImplementation(async (id: number) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab };
    });
    const injected = new Map<number, string[]>();
    chrome.scripting.executeScript.mockImplementation(async (options: { target: { tabId: number }; files?: string[]; func?: () => unknown }) => {
      if (options.func) return [{ frameId: 0, result: pageCaches.has(options.target.tabId) }];
      injected.set(options.target.tabId, [...(injected.get(options.target.tabId) ?? []), ...(options.files ?? [])]);
      return [];
    });
    const shown: Array<{ tabId: number; message: Message }> = [];
    chrome.tabs.sendMessage.mockImplementation((tabId: number, message: Message, reply?: unknown) => {
      if (message.action === "mineClipperIsOpen") return Promise.resolve({ open: false });
      if (typeof reply !== "function") return undefined;
      if (message.action !== "showClipperOverlay") return reply(undefined);
      if (!injected.get(tabId)?.includes("dist/overlay.js")) {
        chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
        reply(undefined);
        chrome.runtime.lastError = undefined;
        return undefined;
      }
      shown.push({ tabId, message });
      return reply({ ok: true });
    });
    return { host, session, injected, shown };
  }

  it("puts the content scripts of the manifest into every open tab they match after an install or update", async () => {
    const tabs = [{ id: 1, url: "https://a.example/story" }, { id: 2, url: "https://x.com/home" },
      { id: 3, url: "https://www.instagram.com/" }, { id: 4, url: "https://c.example/", discarded: true },
      { id: 5, url: "chrome://newtab/" }, { id: 6, url: "https://pro.x.com/i/decks/1" }];
    // The tab of X Pro was loaded with the page world's scripts; the tab of
    // X was open before the install and has none.
    const { host, injected } = worker("build", "build", new Map(), tabs, new Set([6]));
    host.install("update");
    await vi.waitFor(() => expect(injected.get(3)).toEqual([...contentScripts, ...instagramOverlay]));
    await vi.waitFor(() => expect(injected.get(6)).toEqual(contentScripts));
    expect(injected.get(1)).toEqual(contentScripts);
    expect(injected.get(2)).toEqual([...pageWorld, ...contentScripts]);
    expect([...injected.keys()].sort()).toEqual([1, 2, 3, 6]);
    expect(host.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 2, allFrames: false }, world: "MAIN", files: pageWorld });
    expect(host.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 2, allFrames: false }, files: contentScripts });
    // Only the tabs of X are asked about the page world's cache; a page that
    // has it keeps the scripts it loaded.
    const asked = host.chrome.scripting.executeScript.mock.calls
      .map(([options]) => options as { target: { tabId: number }; world?: string; func?: unknown })
      .filter((options) => options.func !== undefined)
      .map((options) => [options.target.tabId, options.world]);
    expect(asked.sort()).toEqual([[2, "MAIN"], [6, "MAIN"]]);
  });

  it("puts nothing after a browser update, nor from files of another build", async () => {
    const tabs = [{ id: 1, url: "https://a.example/story" }];
    const browserUpdate = worker("build", "build", new Map(), tabs);
    browserUpdate.host.install("chrome_update");
    const updated = worker("old", "new", new Map(), tabs);
    updated.host.install("update");
    await vi.waitFor(() => expect(updated.session.get("mineReloadPending")).toBe("new"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(browserUpdate.injected.size).toBe(0);
    expect(updated.injected.size).toBe(0);
  });

  it("opens the clipper after the reload into the build on disk, by the worker of that build", async () => {
    vi.useFakeTimers();
    const local = new Map<string, unknown>();
    const tab = { id: 5, url: "https://x.com/home", title: "Home" };
    const before = worker("old", "new", local, [tab]);
    const preloaded = { metadata: { url: "https://x.com/GasprArt/status/1" }, article: { content: "Post" } };
    await expect(before.host.dispatch({ target: "background", action: "showOverlayInThisTab", pageUrl: tab.url, preloaded },
      { url: tab.url, frameId: 0, tab }).response).resolves.toEqual({ ok: false, mode: "deferred" });
    // Nothing of the files on disk reached this worker's clipper.
    expect(before.injected.size).toBe(0);
    expect(before.host.createWindow).not.toHaveBeenCalled();
    expect(before.session.get("mineReloadPending")).toBe("new");
    expect(local.get("mineOpeningsAfterReload")).toMatchObject({
      5: { pageUrl: tab.url, options: { preloaded, allowWindowFallback: false } },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(before.host.chrome.runtime.reload).toHaveBeenCalledOnce();
    vi.useRealTimers();

    // The tab was loaded under the old build: its page world has the cache.
    const after = worker("new", "new", local, [tab], new Set([tab.id]));
    after.host.install("update");
    await vi.waitFor(() => expect(after.shown).toHaveLength(1));
    // The content scripts of the new build come first, then its overlay.
    expect(after.injected.get(5)).toEqual([...contentScripts, "dist/overlay.js"]);
    expect(after.shown[0]).toMatchObject({ tabId: 5, message: { action: "showClipperOverlay", freshMaterial: true } });
    expect(local.has("mineOpeningsAfterReload")).toBe(false);
    await expect(after.host.dispatch({ target: "background", action: "getClipperLaunch" }, { url: tab.url, tab }).response)
      .resolves.toMatchObject({ sourceTabId: 5, preloaded });
  });

  it("keeps the clip of an overlay whose page changed across the reload, out of session storage meanwhile", async () => {
    vi.useFakeTimers();
    const local = new Map<string, unknown>();
    const tab = { id: 5, url: "https://b.example/next" };
    const before = worker("old", "new", local, [tab]);
    const clip = {
      version: 1, pageUrl: "https://a.example/story", metadata: { url: "https://a.example/story", title: "Kept", selection: "", detectedType: "link" },
      articleData: null, articleExtractionState: "idle", launchedArticle: null, linkTarget: null, title: "Kept", selectedTags: [],
      currentType: "link", destination: { executor: "native", vaultPath: "/v", bindingId: "b", label: "/v" }, edited: true,
    };
    const sender = { url: tab.url, frameId: 0, tab };
    await expect(before.host.dispatch({ target: "background", action: "openClipWrite", clip }, sender).response).resolves.toEqual({ ok: true });
    await expect(before.host.dispatch({ target: "background", action: "restoreOpenClip" }, sender).response)
      .resolves.toEqual({ ok: false, mode: "deferred" });
    expect(before.injected.size).toBe(0);
    expect(before.session.has("mineOpenClip:5")).toBe(false);
    expect(before.session.get("mineOpenClipTabs")).toEqual([]);
    expect(local.get("mineOpeningsAfterReload")).toMatchObject({ 5: { restore: { title: "Kept" } } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(before.host.chrome.runtime.reload).toHaveBeenCalledOnce();
    vi.useRealTimers();

    // The tab moved on meanwhile: the clip opens on the page it shows (Р7).
    tab.url = "https://c.example/later";
    const after = worker("new", "new", local, [tab]);
    after.host.install("update");
    await vi.waitFor(() => expect(after.shown).toHaveLength(1));
    expect(after.shown[0].message).toMatchObject({ action: "showClipperOverlay", freshMaterial: false, restore: { title: "Kept" } });
    expect(after.session.get("mineOpenClipTabs")).toEqual([5]);
  });

  it("drops a launch older than the launch bound or asked on another page", async () => {
    const tabs = [{ id: 5, url: "https://a.example/now" }, { id: 6, url: "https://b.example/" }];
    const local = new Map<string, unknown>([["mineOpeningsAfterReload", {
      5: { pageUrl: "https://a.example/then", createdAt: Date.now(), options: { allowWindowFallback: true } },
      6: { pageUrl: "https://b.example/", createdAt: Date.now() - 11 * 60 * 1000, options: { allowWindowFallback: true } },
    }]]);
    const after = worker("new", "new", local, tabs);
    after.host.install("update");
    await vi.waitFor(() => expect(local.has("mineOpeningsAfterReload")).toBe(false));
    await vi.waitFor(() => expect(after.injected.get(6)).toEqual(contentScripts));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(after.shown).toEqual([]);
    expect([...after.injected.values()].flat()).not.toContain("dist/overlay.js");
  });

  it("reads neither Defuddle nor the setup page of another build; the open clipper keeps them for after its close", async () => {
    const { host, session } = worker("old", "new", new Map(), []);
    const tab = { id: 5, url: "https://a.example/" };
    await expect(host.dispatch({ target: "background", action: "ensureDefuddle" }, { url: tab.url, frameId: 0, tab }).response)
      .resolves.toMatchObject({ ok: false, code: "extension_updated" });
    await expect(host.dispatch({ target: "background", action: "openStandaloneSetup" }).response)
      .resolves.toMatchObject({ ok: false, code: "extension_updated" });
    expect(host.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(host.createWindow).not.toHaveBeenCalled();
    expect(session.get("mineReloadPending")).toBe("new");
    expect(host.chrome.runtime.reload).not.toHaveBeenCalled();
  });

  it("opens nothing from files that name no build, and makes no reload pending", async () => {
    const host = background("promise", { fetch: async () => ({ ok: false, json: async () => ({}) }) });
    await expect(host.run(`openClipperUi(${JSON.stringify({ id: 5, url: "https://a.example/" })})`))
      .rejects.toThrow("do not match the running extension");
    expect(host.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(host.chrome.storage.session.set).not.toHaveBeenCalledWith(expect.objectContaining({ mineReloadPending: expect.anything() }));
  });
});
