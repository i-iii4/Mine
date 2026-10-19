import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { present, sourceSection } from "./background.fixtures";

type NativeResponse = Record<string, unknown>;
const checkId = "dd830aea-79ae-4b2e-9e09-66c37c70f96c";
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "background.js"), "utf8");
// Execute the actual native transport and the checks it reads the helper's
// answers through; unrelated tab/capture listeners need no mocks.
const values = sourceSection(source, "// ── Values from outside this worker", "function isContentScriptCompatible");
const transport = sourceSection(source, "// ── Native messaging", "async function broadcastChannelsChanged");
// The worker imports it before its own code (К4).
const extensionBuild = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib/extensionBuild.js"), "utf8");

function nativeTransport() {
  let respond: (message: NativeResponse) => void = () => undefined;
  let disconnect = () => undefined;
  const port = {
    onMessage: { addListener: (listener: typeof respond) => { respond = listener; } },
    onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
    postMessage: vi.fn<(message: NativeResponse) => void>(),
  };
  const connectNative = vi.fn(() => port);
  const warn = vi.fn();
  const context = createContext({
    HOST_NAME: "test.mine",
    // A worker always has storage; no update is pending here.
    chrome: { runtime: { connectNative }, storage: { session: { get: async () => ({}) } } },
    console: { warn },
    crypto: { randomUUID: () => checkId },
    setTimeout, clearTimeout,
  });
  runInContext(extensionBuild, context);
  runInContext(values, context);
  runInContext(transport, context);
  const send = (action: string): Promise<NativeResponse> =>
    runInContext(`sendNativeMessage({action:${JSON.stringify(action)}})`, context);
  return { send, respond: (message: NativeResponse) => respond(message), disconnect: () => disconnect(), port, connectNative, warn };
}

describe("native connection-check acknowledgement", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("acknowledges only a successful correlated status, without changing its response", async () => {
    const host = nativeTransport();
    const result = host.send("get_status");
    const status = { _messageId: 1, ok: true, connected: true, vaultConfigured: false, features: ["connection_check_v1"] };
    host.respond(status);
    await expect(result).resolves.toEqual(status);
    expect(host.port.postMessage.mock.calls[1]?.[0]).toEqual({ action: "confirm_connection_check", check_id: checkId, _messageId: 2 });
    host.respond({ _messageId: 2, ok: false, code: "connection_check_failed" });
    await Promise.resolve();
    expect(host.warn).toHaveBeenCalledOnce();
    expect(host.connectNative).toHaveBeenCalledOnce();
  });

  it.each([
    { ok: false, connected: true, features: ["connection_check_v1"] },
    { ok: true, connected: false, features: ["connection_check_v1"] },
    { ok: true, connected: true, features: [] },
  ])("does not send a write to an unavailable or older host: %j", async (status) => {
    const host = nativeTransport();
    const result = host.send("get_status");
    host.respond({ ...status, _messageId: 1 });
    await result;
    expect(host.port.postMessage).toHaveBeenCalledOnce();
  });

  it("does not let a lost ACK delay or acknowledge a save", async () => {
    const host = nativeTransport();
    const status = host.send("get_status");
    host.respond({ _messageId: 1, ok: true, connected: true, features: ["connection_check_v1"] });
    await status;
    const save = host.send("save_block");
    host.respond({ _messageId: 3, ok: true, outcome: "committed", slug: "Card" });
    await expect(save).resolves.toMatchObject({ outcome: "committed", slug: "Card" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.warn).toHaveBeenCalledOnce();
    expect(host.port.postMessage).toHaveBeenCalledTimes(3);
  });

  it("never ACKs an uncorrelated status or reconnects to write diagnostics", async () => {
    const host = nativeTransport();
    const status = host.send("get_status");
    host.respond({ _messageId: 999, ok: true, connected: true, features: ["connection_check_v1"] });
    expect(host.port.postMessage).toHaveBeenCalledOnce();
    host.disconnect();
    await expect(status).resolves.toMatchObject({ code: "native_disconnected" });
    host.respond({ _messageId: 1, ok: true, connected: true, features: ["connection_check_v1"] });
    expect(host.connectNative).toHaveBeenCalledOnce();
    expect(host.port.postMessage).toHaveBeenCalledOnce();
  });
});

describe("a Save waits as long as the helper works (SPEC_DEEP_AUDIT.md, Н9)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  async function helperWith(features: string[]) {
    const host = nativeTransport();
    const status = host.send("get_status");
    host.respond({ _messageId: 1, ok: true, connected: true, features });
    await status;
    const save = host.send("save_block");
    let settled = false;
    void save.then(() => { settled = true; });
    const sent = present(host.port.postMessage.mock.calls.at(-1), "the Save request")[0];
    return { host, save, sent, settled: async () => { await Promise.resolve(); await Promise.resolve(); return settled; } };
  }

  it("asks for signs of work and waits while they come, however long the save", async () => {
    const { host, save, sent, settled } = await helperWith(["save_progress_v1"]);
    expect(sent._progress).toBe(true);
    for (let minute = 0; minute < 10; minute += 1) {
      await vi.advanceTimersByTimeAsync(50_000);
      host.respond({ _messageId: sent._messageId, progress: true });
    }
    expect(await settled()).toBe(false);
    host.respond({ _messageId: sent._messageId, ok: true, outcome: "committed", slug: "Card" });
    await expect(save).resolves.toMatchObject({ outcome: "committed", slug: "Card" });
    expect(host.warn).not.toHaveBeenCalled();
  });

  it("gives up a minute after the last sign of work", async () => {
    const { host, save, sent, settled } = await helperWith(["save_progress_v1"]);
    await vi.advanceTimersByTimeAsync(59_000);
    host.respond({ _messageId: sent._messageId, progress: true });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(save).resolves.toMatchObject({ code: "native_timeout", outcome: "unknown" });
  });

  it("keeps the old three minutes for a helper that sends no signs", async () => {
    const { save, settled } = await helperWith([]);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(await settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(save).resolves.toMatchObject({ code: "native_timeout", outcome: "unknown" });
  });
});

describe("helper replaced during a session (SPEC_CLIPPER.md, К4)", () => {
  function replaceableTransport() {
    const ports: Array<{
      respond: (message: NativeResponse) => void;
      postMessage: Mock<(message: NativeResponse) => void>;
      disconnect: Mock<() => void>;
    }> = [];
    const connectNative = vi.fn(() => {
      const entry = {
        respond: (_message: NativeResponse): void => undefined,
        postMessage: vi.fn<(message: NativeResponse) => void>(),
        disconnect: vi.fn<() => void>(),
      };
      ports.push(entry);
      return {
        onMessage: { addListener: (listener: (message: NativeResponse) => void) => { entry.respond = listener; } },
        onDisconnect: { addListener: () => undefined },
        postMessage: entry.postMessage,
        disconnect: entry.disconnect,
      };
    });
    const context = createContext({
      HOST_NAME: "test.mine",
      chrome: { runtime: { connectNative } },
      console: { warn: vi.fn() },
      crypto: { randomUUID: () => checkId },
      setTimeout, clearTimeout,
    });
    runInContext(extensionBuild, context);
    runInContext(values, context);
    runInContext(transport, context);
    const send = (action: string): Promise<NativeResponse> =>
      runInContext(`sendNativeMessage({action:${JSON.stringify(action)}})`, context);
    return { send, ports, connectNative };
  }

  it("reconnects to the new helper and sends every unanswered request again, once", async () => {
    const host = replaceableTransport();
    const save = host.send("save_block");
    const status = host.send("get_status");
    const old = present(host.ports[0], "the first helper");
    old.respond({ _messageId: 1, ok: false, code: "host_replaced", outcome: "not_committed" });
    await vi.waitFor(() => expect(host.connectNative).toHaveBeenCalledTimes(2));
    expect(old.disconnect).toHaveBeenCalledOnce();
    const fresh = present(host.ports[1], "the new helper");
    await vi.waitFor(() => expect(fresh.postMessage).toHaveBeenCalledTimes(2));
    const sent = fresh.postMessage.mock.calls.map(([message]) => message);
    expect(sent.map((message) => message.action)).toEqual(["save_block", "get_status"]);
    fresh.respond({ _messageId: sent[0]?._messageId, ok: true, outcome: "committed" });
    fresh.respond({ _messageId: sent[1]?._messageId, ok: true, connected: true, features: [] });
    await expect(save).resolves.toMatchObject({ outcome: "committed" });
    await expect(status).resolves.toMatchObject({ connected: true });
  });

  it("does not loop when the new helper is replaced too", async () => {
    const host = replaceableTransport();
    const status = host.send("get_status");
    present(host.ports[0], "the first helper").respond({ _messageId: 1, ok: false, code: "host_replaced", outcome: "not_committed" });
    await vi.waitFor(() => expect(host.ports[1]?.postMessage).toHaveBeenCalledOnce());
    present(host.ports[1], "the new helper").respond({ _messageId: 2, ok: false, code: "host_replaced", outcome: "not_committed" });
    await expect(status).resolves.toMatchObject({ code: "host_replaced", outcome: "not_committed" });
    expect(host.connectNative).toHaveBeenCalledTimes(2);
  });
});

describe("extension update applies itself (SPEC_CLIPPER.md, К4)", () => {
  // `ownBuild` is the build written into the worker's code
  // (dist/build-identity.js); `onDisk` is what a file read now would answer:
  // the copy an update has already replaced.
  function updatableTransport(
    ownBuild: string | null,
    stored: Record<string, unknown> = {},
    open: { pages?: number; overlays?: boolean[] } = {},
    onDisk: string | null = ownBuild,
  ) {
    let respond: (message: NativeResponse) => void = () => undefined;
    const local = { ...stored };
    const session: Record<string, unknown> = {};
    const reload = vi.fn();
    const overlays = open.overlays ?? [];
    const tabs = {
      query: async () => overlays.map((_, id) => ({ id })),
      sendMessage: async (id: number) => ({ open: overlays[id] }),
    };
    const port = {
      onMessage: { addListener: (listener: typeof respond) => { respond = listener; } },
      onDisconnect: { addListener: () => undefined },
      postMessage: vi.fn<(message: NativeResponse) => void>(),
    };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ buildId: onDisk, commit: "c" }) }));
    // The clips kept for tabs and the openings that wait for the reload belong
    // to the clipper part of the worker, which background.messaging.test.ts
    // runs whole; here they only report that the reload reached them.
    const carryKeptClips = vi.fn(async () => undefined);
    const tellOpeningsHeldByClipper = vi.fn(async () => undefined);
    const context = createContext({
      carryKeptClips, tellOpeningsHeldByClipper, dropCarriedClips: async () => undefined,
      HOST_NAME: "test.mine",
      chrome: {
        runtime: {
          connectNative: () => port,
          getURL: (path: string) => `chrome-extension://id/${path}`,
          getContexts: async () => Array.from({ length: open.pages ?? 0 }, () => ({})),
          reload,
        },
        tabs,
        storage: {
          local: {
            get: async (key: string) => ({ [key]: local[key] }),
            set: async (values: Record<string, unknown>) => { Object.assign(local, values); },
            remove: async (key: string) => { delete local[key]; },
          },
          session: {
            get: async (key: string) => ({ [key]: session[key] }),
            set: async (values: Record<string, unknown>) => { Object.assign(session, values); },
            remove: async (key: string) => { delete session[key]; },
          },
        },
      },
      MineBuildIdentity: ownBuild === null ? undefined : { buildId: ownBuild, commit: "c" },
      fetch,
      console: { warn: vi.fn() },
      crypto: { randomUUID: () => checkId },
      setTimeout, clearTimeout,
    });
    runInContext(extensionBuild, context);
    runInContext(values, context);
    runInContext(transport, context);
    const send = (action: string): Promise<NativeResponse> =>
      runInContext(`sendNativeMessage({action:${JSON.stringify(action)}})`, context);
    const closed = (): Promise<void> => runInContext("reloadIfUpdated()", context);
    // The worker's own trackBrowserWrite; the script's value comes back untyped.
    const trackBrowserWrite: (work: () => Promise<unknown>) => Promise<unknown> = runInContext("trackBrowserWrite", context);
    const browserWrite = (work: () => Promise<unknown>): Promise<unknown> => trackBrowserWrite(work);
    return { send, closed, browserWrite, respond: (message: NativeResponse) => respond(message), reload, local, session, fetch,
      carryKeptClips, tellOpeningsHeldByClipper };
  }

  async function statusFrom(host: ReturnType<typeof updatableTransport>, installed: string) {
    const status = host.send("get_status");
    host.respond({ _messageId: 1, ok: true, connected: true, features: [], extension_build_id: installed });
    await status;
    await vi.waitFor(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("reloads once the clipper closes when a newer build is installed", async () => {
    const host = updatableTransport("old-build");
    await statusFrom(host, "new-build");
    expect(host.reload).not.toHaveBeenCalled();
    await host.closed();
    expect(host.reload).toHaveBeenCalledOnce();
    expect(host.local.mineReloadedFor).toBe("new-build");
    // The clips kept for tabs cross the reload (SPEC_CLIPPER.md, К4, «Значок после обновления»).
    expect(host.carryKeptClips).toHaveBeenCalledOnce();
  });

  it("compares the build written into the worker, not the copy on disk the update replaced", async () => {
    // After the files were replaced a file read answers the new build; the
    // worker still runs the old code and must reload into the new one.
    const host = updatableTransport("old-build", {}, {}, "new-build");
    await statusFrom(host, "new-build");
    expect(host.session.mineReloadPending).toBe("new-build");
    await host.closed();
    expect(host.reload).toHaveBeenCalledOnce();
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it("keeps a worker whose code carries no build", async () => {
    const host = updatableTransport(null, {}, {}, "old-build");
    await statusFrom(host, "new-build");
    await host.closed();
    expect(host.session.mineReloadPending).toBeUndefined();
    expect(host.reload).not.toHaveBeenCalled();
  });

  it("does nothing when the running build is the installed one", async () => {
    const host = updatableTransport("same-build");
    await statusFrom(host, "same-build");
    await host.closed();
    expect(host.reload).not.toHaveBeenCalled();
  });

  it("never reloads twice for the same installed build", async () => {
    const host = updatableTransport("old-build", { mineReloadedFor: "new-build" });
    await statusFrom(host, "new-build");
    await host.closed();
    expect(host.reload).not.toHaveBeenCalled();
  });

  it("waits for a save that is still in flight", async () => {
    const host = updatableTransport("old-build");
    await statusFrom(host, "new-build");
    void host.send("save_block");
    await host.closed();
    expect(host.reload).not.toHaveBeenCalled();
    expect(host.session.mineReloadPending).toBe("new-build");
  });

  it("keeps a clipper open in another tab", async () => {
    const host = updatableTransport("old-build", {}, { overlays: [false, true] });
    await statusFrom(host, "new-build");
    await host.closed();
    expect(host.reload).not.toHaveBeenCalled();
    expect(host.session.mineReloadPending).toBe("new-build");
    // The openings waiting for this reload hear why (19.10.2026).
    expect(host.tellOpeningsHeldByClipper).toHaveBeenCalledOnce();
  });

  it("keeps the clipper window or the folder setup page open", async () => {
    const host = updatableTransport("old-build", {}, { pages: 1 });
    await statusFrom(host, "new-build");
    await host.closed();
    expect(host.reload).not.toHaveBeenCalled();
  });

  it("waits for a save into the browser folder and reloads after it", async () => {
    vi.useFakeTimers();
    try {
      const host = updatableTransport("old-build");
      const status = host.send("get_status");
      host.respond({ _messageId: 1, ok: true, connected: true, features: [], extension_build_id: "new-build" });
      await status;
      await vi.waitFor(() => expect(host.session.mineReloadPending).toBe("new-build"));
      let finish: (value: unknown) => void = () => undefined;
      const save = host.browserWrite(() => new Promise((resolve) => { finish = resolve; }));
      await Promise.resolve();
      await host.closed();
      expect(host.reload).not.toHaveBeenCalled();
      finish({ ok: true });
      await save;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(host.reload).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });
});
