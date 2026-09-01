import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type BrowserApiMode = "callback" | "promise";
type Message = Record<string, unknown>;
type MessageListener = (
  message: Message,
  sender: { url?: string },
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
      query: vi.fn(async () => []),
      sendMessage: vi.fn(),
    },
    windows: {
      create: createWindow,
      getCurrent: vi.fn(async () => ({ id: 1 })),
      onBoundsChanged: eventSink(),
      onRemoved: eventSink(),
      update: vi.fn(async () => undefined),
    },
  };

  const context = createContext({
    URL,
    chrome,
    console,
    crypto: { randomUUID: () => "bcb8f719-aa35-44f5-9a47-17b4d52f530f" },
    importScripts: vi.fn(),
    setTimeout,
    clearTimeout,
  });
  runInContext(source, context);

  function dispatch(message: Message, sender: { url?: string } = {}) {
    let resolveResponse: (response: Message) => void = () => undefined;
    const response = new Promise<Message>((resolve) => { resolveResponse = resolve; });
    const keepAlive = receiveRuntimeMessage(message, sender, resolveResponse);
    return { keepAlive, response };
  }

  return {
    chrome,
    createTab,
    createWindow,
    dispatch,
    disconnectNative,
    nativePort,
    receiveNativeMessage: (message: Message) => receiveNativeMessage(message),
  };
}

describe.each<BrowserApiMode>(["callback", "promise"])("background messaging with %s browser APIs", (apiMode) => {
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
