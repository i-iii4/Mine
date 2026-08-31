import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NativeResponse = Record<string, unknown>;
const checkId = "dd830aea-79ae-4b2e-9e09-66c37c70f96c";
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "background.js"), "utf8");
// Execute the actual native transport; unrelated tab/capture listeners need no mocks.
const transport = source.slice(source.indexOf("// ── Native messaging"), source.indexOf("async function broadcastChannelsChanged"));

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
    chrome: { runtime: { connectNative } },
    console: { warn },
    crypto: { randomUUID: () => checkId },
    setTimeout, clearTimeout,
  });
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
    expect(host.port.postMessage.mock.calls[1][0]).toEqual({ action: "confirm_connection_check", check_id: checkId, _messageId: 2 });
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
