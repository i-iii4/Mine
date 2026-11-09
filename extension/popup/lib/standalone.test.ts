import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { standaloneSave } from "./standalone";

// SPEC_CLIPPER.md, «Один путь файла со страницы», Б13: a Save into a browser
// folder runs on a port, whose messages keep the background alive through a long
// write; a port that closes first says nothing about the write.
type Listener = (message: unknown) => void;

function fakeRuntime() {
  const posted: unknown[] = [];
  const message: Listener[] = [];
  const closed: Array<() => void> = [];
  const disconnect = vi.fn();
  const sendMessage = vi.fn((request: { action?: string }, reply: (response: unknown) => void) => {
    reply({ ok: true, outcome: "committed", looked_up: request.action });
  });
  const connect = vi.fn(() => ({
    onMessage: { addListener: (listener: Listener) => { message.push(listener); } },
    onDisconnect: { addListener: (listener: () => void) => { closed.push(listener); } },
    postMessage: (value: unknown) => { posted.push(value); },
    disconnect,
  }));
  vi.stubGlobal("chrome", { runtime: { connect, sendMessage, lastError: undefined } });
  return {
    posted, connect, disconnect, sendMessage,
    answer: (value: unknown) => { for (const listener of message) listener(value); },
    close: () => { for (const listener of closed) listener(); },
  };
}

const PAYLOAD = { operation_id: "clip-1", binding_id: "folder-1", title: "Clip" };

describe("standaloneSave", () => {
  beforeEach(() => vi.stubGlobal("crypto", { randomUUID: () => "port-id" }));
  afterEach(() => vi.unstubAllGlobals());

  it("starts on its own port and resolves with the answer", async () => {
    const runtime = fakeRuntime();
    const saved = standaloneSave(PAYLOAD);
    expect(runtime.connect).toHaveBeenCalledWith({ name: "mine-standalone-save:port-id" });
    expect(runtime.posted).toEqual([{ kind: "start", payload: PAYLOAD }]);
    runtime.answer({ kind: "done", response: { ok: true, outcome: "committed", slug: "Cards/Clip" } });
    await expect(saved).resolves.toEqual({ ok: true, outcome: "committed", slug: "Cards/Clip" });
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("answers the background's progress: its event resets the idle time", () => {
    const runtime = fakeRuntime();
    void standaloneSave(PAYLOAD);
    runtime.answer({ kind: "progress" });
    expect(runtime.posted.at(-1)).toEqual({ kind: "progress" });
  });

  it("asks for the outcome when the port closes first", async () => {
    const runtime = fakeRuntime();
    const saved = standaloneSave(PAYLOAD);
    runtime.close();
    await expect(saved).resolves.toMatchObject({ outcome: "committed", looked_up: "standaloneLookup" });
    expect(runtime.sendMessage.mock.calls[0]?.[0]).toMatchObject({ action: "standaloneLookup", operation_id: "clip-1", binding_id: "folder-1" });
  });

  it("says the transport failed when a port closes on a save that names no operation", async () => {
    const runtime = fakeRuntime();
    const saved = standaloneSave({ title: "Clip" });
    runtime.close();
    await expect(saved).resolves.toMatchObject({ ok: false, outcome: "unknown", code: "extension_transport" });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("does not look up after its answer", async () => {
    const runtime = fakeRuntime();
    const saved = standaloneSave(PAYLOAD);
    runtime.answer({ kind: "done", response: { ok: false, outcome: "unknown" } });
    runtime.close();
    await expect(saved).resolves.toEqual({ ok: false, outcome: "unknown" });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});
