import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type BrowserApiMode = "callback" | "promise";
type Message = Record<string, unknown>;
type MessageListener = (
  message: Message,
  sender: { url?: string; tab?: { id: number; windowId?: number } },
  sendResponse: (response: Message) => void,
) => boolean | undefined;

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "background.js"), "utf8");

function eventSink(register?: (listener: unknown) => void) {
  return { addListener: vi.fn((listener: unknown) => register?.(listener)) };
}

function background(apiMode: BrowserApiMode) {
  let receiveRuntimeMessage: MessageListener = () => undefined;
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
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onInstalled: eventSink(),
      onMessage: eventSink((listener) => { receiveRuntimeMessage = listener as MessageListener; }),
      sendMessage: vi.fn(() => Promise.resolve()),
    },
    scripting: { executeScript: vi.fn() },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
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

  const draftStore = { attach: vi.fn(async () => ({ draft: null, draftId: "capture", generation: 1 })), writeOwned: vi.fn(async () => null) };
  const context = createContext({
    MineDraftStore: draftStore,
    URL,
    chrome,
    console,
    crypto: { randomUUID: () => "bcb8f719-aa35-44f5-9a47-17b4d52f530f" },
    importScripts: vi.fn(),
    setTimeout,
    clearTimeout,
    fetch: vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "worker-build", commit: "worker-commit" }) })),
  });
  runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/saveProtocol.js"), "utf8"), context);
  runInContext(source, context);

  function dispatch(message: Message, sender: { url?: string; tab?: { id: number; windowId?: number } } = {}) {
    let resolveResponse: (response: Message) => void = () => undefined;
    const response = new Promise<Message>((resolve) => { resolveResponse = resolve; });
    const keepAlive = receiveRuntimeMessage(message, sender, resolveResponse);
    return { keepAlive, response };
  }

  return {
    chrome,
    run: (code: string): Promise<unknown> => Promise.resolve(runInContext(code, context)),
    draftStore,
    createTab,
    createWindow,
    dispatch,
    disconnectNative,
    nativePort,
    receiveNativeMessage: (message: Message) => receiveNativeMessage(message),
  };
}

describe.each<BrowserApiMode>(["callback", "promise"])("background messaging with %s browser APIs", (apiMode) => {
  it("takes capture scope from the sender instead of page-supplied options", async () => {
    const worker = background(apiMode);
    await expect(worker.dispatch({ target: "background", action: "draftAttach", sourceUrl: "https://example.com", sourceTabId: 99,
      options: { ownerId: "owner", captureId: "capture", captureScope: "forged" } }, { tab: { id: 7 } }).response).resolves.toMatchObject({ ok: true, draft: { generation: 1 } });
    expect(worker.draftStore.attach).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ captureScope: "7" }));
  });
  it("creates one durable browser session for concurrent attaches and ignores forged sessions", async () => {
    const worker = background(apiMode);
    worker.chrome.tabs.query.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    await Promise.all([7, 8].map(id => worker.dispatch({ target: "background", action: "draftAttach", sourceUrl: "https://example.com",
      options: { ownerId: String(id), captureId: String(id), captureSession: "forged", activeScopes: [] } }, { tab: { id } }).response));
    expect(worker.chrome.storage.session.set).toHaveBeenCalledOnce();
    expect(worker.draftStore.attach).toHaveBeenCalledWith("https://example.com", expect.objectContaining({
      captureSession: "bcb8f719-aa35-44f5-9a47-17b4d52f530f", activeScopes: ["extension", "7", "8"],
    }));
  });
  it("uses the existing browser session after worker restart and the source tab of an extension window", async () => {
    const worker = background(apiMode);
    worker.chrome.storage.session.get.mockResolvedValue({ mineDraftBrowserSession: "still-this-browser" });
    await worker.dispatch({ target: "background", action: "draftAttach", sourceUrl: "https://example.com", sourceTabId: 7,
      options: { ownerId: "owner", captureId: "capture" } }, { url: "chrome-extension://test/dist/index.html", tab: { id: 99 } }).response;
    expect(worker.chrome.storage.session.set).not.toHaveBeenCalled();
    expect(worker.draftStore.attach).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ captureScope: "7", captureSession: "still-this-browser" }));
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

describe("widget and background compatibility", () => {
  it("accepts an older widget through the retained baseline, independently of build identity", async () => {
    const worker = background("promise");
    const request = worker.dispatch({ target: "background", action: "clipperHandshake", build_id: "old-widget", save_protocols: [1] });
    await expect(request.response).resolves.toMatchObject({ ok: true, save_protocols: [1], build_id: "worker-build", commit: "worker-commit" });
    expect(worker.nativePort.postMessage).not.toHaveBeenCalled();
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

describe("a clipper opening belongs to its source tab (SPEC_AUDIT_FIXES.md, Ф6)", () => {
  function launchWorker() {
    const worker = background("promise");
    const session: Record<string, unknown> = {};
    worker.chrome.storage.session.get.mockImplementation(async (key: unknown) => ({ [key as string]: session[key as string] }));
    worker.chrome.storage.session.set.mockImplementation(async (values: unknown) => { Object.assign(session, values); });
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
    const capture = () => worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5 }, fromWindow).response;

    chrome.tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: false });
    await expect(capture()).resolves.toMatchObject({ ok: false });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();

    chrome.tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true });
    chrome.tabs.query.mockResolvedValue([{ id: 6 }]);
    await expect(capture()).resolves.toMatchObject({ ok: false });
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(3, expect.anything(), expect.any(Function));

    chrome.tabs.query.mockResolvedValue([{ id: 5 }]);
    await expect(capture()).resolves.toMatchObject({ ok: true, dataUrl: "data:image/jpeg;base64,AA" });
  });
});
