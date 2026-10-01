import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function background(apiMode: BrowserApiMode, options: { realDraftStore?: boolean } = {}) {
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
      getContexts: vi.fn(async () => [] as unknown[]),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      reload: vi.fn(),
      onInstalled: eventSink(),
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

  const draftStore = { attach: vi.fn(async () => ({ draft: null, draftId: "capture", generation: 1 })), writeOwned: vi.fn(async () => null) };
  const context = createContext({
    MineDraftStore: draftStore,
    TextEncoder,
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
  if (options.realDraftStore) {
    // The worker's actual draft queue, over the storage the test controls.
    runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/storedValue.js"), "utf8"), context);
    runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/draftStore.js"), "utf8"), context);
  }
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
    // Like the browser's storage: every read is a copy, so a change is seen
    // only once it is written back.
    worker.chrome.storage.session.get.mockImplementation(async (key: unknown) => ({ [key as string]: structuredClone(session[key as string]) }));
    worker.chrome.storage.session.set.mockImplementation(async (values: unknown) => { Object.assign(session, structuredClone(values)); });
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
    const capture = () => worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5, documentUrl: page }, fromWindow).response;

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

  describe("a screenshot belongs to the page address the clipper opened for (Б4.5)", () => {
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

    it("refuses the window's screenshot once its source tab moved from A to B", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageB });
      tabs.query.mockResolvedValue([{ id: 5, url: pageB }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5, documentUrl: pageA }, fromWindow).response;
      expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("another page") });
      expect(reply).not.toHaveProperty("dataUrl");
      expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
    });

    it("refuses the overlay's screenshot after its page changed address in place", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageB });
      tabs.query.mockResolvedValue([{ id: 5, url: pageB }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop", documentUrl: pageA }, { url: pageB, tab: { id: 5 } }).response;
      expect(reply).toMatchObject({ ok: false });
      expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
    });

    it("drops a frame taken while the page moved away", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageA });
      tabs.query.mockResolvedValue([{ id: 5, url: pageB }]);
      const reply = await worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5, documentUrl: pageA }, fromWindow).response;
      expect(reply).toMatchObject({ ok: false });
      expect(reply).not.toHaveProperty("dataUrl");
    });

    it("refuses a request that names no page", async () => {
      const { worker, tabs } = captureWorker();
      tabs.get.mockResolvedValue({ id: 5, windowId: 3, active: true, url: pageA });
      await expect(worker.dispatch({ target: "background", action: "captureForCrop", tabId: 5 }, fromWindow).response)
        .resolves.toMatchObject({ ok: false });
      expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
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
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: 5, documentUrl: page }, fromWindow).response;
      expect(reply).toEqual({ ok: true });
      expect(tabs.sendMessage).toHaveBeenCalledWith(5, { action: "startCropOverlay", documentUrl: page, cropId: null }, expect.any(Function));
      expect(tabs.sendMessage).not.toHaveBeenCalledWith(900, expect.anything(), expect.anything());
    });

    it("does not start a crop once the source tab shows another page", async () => {
      const { worker, tabs } = cropWorker("https://b.example/other");
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: 5, documentUrl: page }, fromWindow).response;
      expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("another page") });
      expect(tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("keeps an overlay's crop in the overlay's own tab, under the overlay's crop id (Г3.3)", async () => {
      const { worker, tabs } = cropWorker(page);
      const reply = await worker.dispatch({ target: "background", action: "startCropMode", tabId: -1, documentUrl: page, cropId: "crop-1" }, { url: page, tab: { id: 5 } }).response;
      expect(reply).toEqual({ ok: true });
      expect(tabs.sendMessage).toHaveBeenCalledWith(5, { action: "startCropOverlay", documentUrl: page, cropId: "crop-1" }, expect.any(Function));
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

describe("an extension update waits for the draft queue (SPEC_AUDIT_FIXES.md, Б4.1)", () => {
  afterEach(() => vi.useRealTimers());

  const sourceUrl = "https://example.com/story";
  const tab = { id: 7 };
  const ownership = { ownerId: "editor", generation: 1 };

  /// The actual worker and draft store over storage whose draft writes the
  /// test holds, with an update waiting and no clipper left open.
  function updatingWorker() {
    vi.useFakeTimers();
    const worker = background("promise", { realDraftStore: true });
    const local = new Map<string, unknown>();
    const session = new Map<string, unknown>([["mineReloadPending", "new-build"]]);
    let holding = false;
    let held: Array<() => void> = [];
    const isDraft = (name: string) => name.startsWith("mineDurableDraft");
    const read = (store: Map<string, unknown>, key: unknown) => key === null
      ? Object.fromEntries([...store].map(([name, value]) => [name, structuredClone(value)]))
      : { [key as string]: structuredClone(store.get(key as string)) };
    const change = async (names: string[], apply: () => void) => {
      if (holding && names.some(isDraft)) {
        await new Promise<void>((resolve) => { held.push(() => { apply(); resolve(); }); });
        return;
      }
      apply();
    };
    const storage = worker.chrome.storage as unknown as Record<"local" | "session", Record<string, ReturnType<typeof vi.fn>>>;
    storage.local.get.mockImplementation(async (key: unknown) => read(local, key));
    storage.local.set.mockImplementation((values: Record<string, unknown>) => change(Object.keys(values),
      () => { for (const [name, value] of Object.entries(values)) local.set(name, structuredClone(value)); }));
    storage.local.remove.mockImplementation((name: string) => change([name], () => { local.delete(name); }));
    storage.session.get.mockImplementation(async (key: unknown) => read(session, key));
    storage.session.set.mockImplementation(async (values: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(values)) session.set(name, structuredClone(value));
    });
    storage.session.remove.mockImplementation(async (name: string) => { session.delete(name); });
    const send = (message: Message) => worker.dispatch({ target: "background", sourceUrl, ...message }, { tab }).response;
    return {
      worker, local, send,
      hold: () => { holding = true; },
      release: () => { holding = false; const waiting = held; held = []; waiting.forEach((finish) => finish()); },
    };
  }

  const writeDraft = (host: ReturnType<typeof updatingWorker>, title: string, sequence: number) => host.send({
    action: "draftWriteOwned", expectedRevision: sequence - 1,
    draft: { schemaVersion: 1, revision: sequence, draftId: "capture", state: { title } },
    ownership: { ...ownership, mutationId: `edit-${sequence}`, sequence },
  });

  it("keeps the last edit: no reload while it is stored, the reload once it is", async () => {
    const host = updatingWorker();
    await expect(host.send({ action: "draftAttach", options: { ownerId: "editor", captureId: "capture" } }))
      .resolves.toMatchObject({ ok: true, draft: { draftId: "capture", generation: 1 } });
    host.hold();
    const written = writeDraft(host, "Latest edit", 1);
    // Escape: the overlay closes and no editor is left open.
    host.worker.dispatch({ target: "background", action: "mineClipperClosed" }, { tab });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.worker.chrome.runtime.reload).not.toHaveBeenCalled();

    host.release();
    await expect(written).resolves.toMatchObject({ ok: true, draft: { revision: 1, state: { title: "Latest edit" } } });
    expect(host.worker.chrome.runtime.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.worker.chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(host.local.get("mineDurableDraftRecord:capture")).toMatchObject({ draft: { state: { title: "Latest edit" } } });
  });

  it("removes the saved clip's draft before the reload, so it does not come back", async () => {
    const host = updatingWorker();
    await host.send({ action: "draftAttach", options: { ownerId: "editor", captureId: "capture" } });
    await writeDraft(host, "Saved clip", 1);
    host.hold();
    const cleared = host.send({ action: "draftClearOwned", draftId: "capture", expectedRevision: 1, ownership });
    host.worker.dispatch({ target: "background", action: "mineClipperClosed" }, { tab });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.worker.chrome.runtime.reload).not.toHaveBeenCalled();
    expect(host.local.has("mineDurableDraftRecord:capture")).toBe(true);

    host.release();
    await expect(cleared).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.worker.chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(host.local.has("mineDurableDraftRecord:capture")).toBe(false);
  });
});

describe("an extension update checks again right before the reload (SPEC_AUDIT_FIXES.md, В4.6)", () => {
  afterEach(() => vi.useRealTimers());

  const sourceUrl = "https://example.com/story";
  const tab = { id: 7 };
  const ownership = { ownerId: "editor", generation: 1 };

  /// The actual worker and draft store with an update waiting, over storage
  /// whose draft writes the test can hold.
  function updatingWorker() {
    vi.useFakeTimers();
    const worker = background("promise", { realDraftStore: true });
    const local = new Map<string, unknown>();
    const session = new Map<string, unknown>([["mineReloadPending", "new-build"]]);
    let holding = false;
    let held: Array<() => void> = [];
    const read = (store: Map<string, unknown>, key: unknown) => key === null
      ? Object.fromEntries([...store].map(([name, value]) => [name, structuredClone(value)]))
      : { [key as string]: structuredClone(store.get(key as string)) };
    const change = async (names: string[], apply: () => void) => {
      if (holding && names.some((name) => name.startsWith("mineDurableDraft"))) {
        await new Promise<void>((resolve) => { held.push(() => { apply(); resolve(); }); });
        return;
      }
      apply();
    };
    const storage = worker.chrome.storage as unknown as Record<"local" | "session", Record<string, ReturnType<typeof vi.fn>>>;
    storage.local.get.mockImplementation(async (key: unknown) => read(local, key));
    storage.local.set.mockImplementation((values: Record<string, unknown>) => change(Object.keys(values),
      () => { for (const [name, value] of Object.entries(values)) local.set(name, structuredClone(value)); }));
    storage.local.remove.mockImplementation((name: string) => change([name], () => { local.delete(name); }));
    storage.session.get.mockImplementation(async (key: unknown) => read(session, key));
    storage.session.set.mockImplementation(async (values: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(values)) session.set(name, structuredClone(value));
    });
    storage.session.remove.mockImplementation(async (name: string) => { session.delete(name); });
    const send = (message: Message, sender: { tab?: { id: number; url?: string } } = { tab }) =>
      worker.dispatch({ target: "background", sourceUrl, ...message }, sender).response;
    return {
      worker, session, send,
      hold: () => { holding = true; },
      release: () => { holding = false; const waiting = held; held = []; waiting.forEach((finish) => finish()); },
    };
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

  it("does not reload while a draft write that began during the check is still being stored", async () => {
    const host = updatingWorker();
    await host.send({ action: "draftAttach", options: { ownerId: "editor", captureId: "capture" } });
    const answerPages = await checkHeldAtPages(host);

    host.hold();
    const written = host.send({ action: "draftWriteOwned", expectedRevision: 0,
      draft: { schemaVersion: 1, revision: 1, draftId: "capture", state: { title: "Typed during the check" } },
      ownership: { ...ownership, mutationId: "edit-1", sequence: 1 } });
    answerPages([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.worker.chrome.runtime.reload).not.toHaveBeenCalled();
    expect(host.session.get("mineReloadPending")).toBe("new-build");

    host.release();
    await expect(written).resolves.toMatchObject({ ok: true, draft: { state: { title: "Typed during the check" } } });
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
