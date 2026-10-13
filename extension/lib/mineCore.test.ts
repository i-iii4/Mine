// Real no-modules wasm-bindgen glue in a classic-script global environment.
// This catches worker bootstrap errors that the separate Node WASM binding
// cannot detect. Browser CSP enforcement is covered by the worker smoke test.
import { readFileSync } from "node:fs";
import { TextDecoder, TextEncoder } from "node:util";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));
const glue = read("../generated/save-core/mine_core.js").toString();
const adapter = read("./mineCore.js").toString();
const wasmBytes = read("../generated/save-core/mine_core_bg.wasm");

function worker(failFirst = false, includeGlue = true) {
  let calls = 0;
  const fetch = vi.fn(async (path: string) => {
    expect(path).toBe("chrome-extension://test/generated/save-core/mine_core_bg.wasm");
    if (failFirst && calls++ === 0) throw new Error("injected load failure");
    // Supply real bytes to the generated loader; no network or second engine.
    return wasmBytes;
  });
  const context = createContext({ TextDecoder, TextEncoder, URL, fetch,
    chrome: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
  });
  if (includeGlue) runInContext(glue, context, { filename: "mine_core.js" });
  runInContext(adapter, context, { filename: "mineCore.js" });
  return { context, fetch };
}

describe("packaged classic-worker save core", () => {
  it("initializes actual lexical wasm_bindgen and shares one runtime across concurrent calls", async () => {
    const { context, fetch } = worker();
    expect(runInContext("typeof wasm_bindgen", context)).toBe("function");
    expect(runInContext("typeof globalThis.wasm_bindgen", context)).toBe("undefined");
    const replies = await runInContext(`Promise.all([1, 2, 3].map(() => MineCore.call({
      op: "name", title: "One card", url: null,
      layout: { cards: "Cards", media: "Media", collections: "Collections" }, existing: []
    })))`, context);
    expect(replies).toEqual(Array(3).fill({ name: "One card", slug: "Cards/One card" }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a failed load without falling back to another save engine", async () => {
    const { context, fetch } = worker(true);
    const command = `MineCore.call({op:"layout", layout:{cards:"",media:"",collections:""}})`;
    await expect(runInContext(command, context)).rejects.toThrow("injected load failure");
    await expect(runInContext(command, context)).resolves.toEqual({ cards: "", media: "", collections: "" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // К7 (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md): the refusal carries the code and
  // the collection it names, never only words.
  it("carries the collection a collection_not_found names", async () => {
    const { context } = worker();
    const failure = await runInContext(`MineCore.call({op:"collection_pages",
      selected:["Art","Pageless"], with_pages:["Art"]}).then(() => null, (error) => error)`, context);
    expect(failure.code).toBe("collection_not_found");
    expect(failure.collection).toBe("Pageless");
    expect(failure.message).toBe("collection \"Pageless\" has no page; nothing was written");
  });

  it("reports missing generated glue explicitly", async () => {
    const { context, fetch } = worker(false, false);
    await expect(runInContext(`MineCore.call({op:"fingerprint",value:"{}"})`, context))
      .rejects.toThrow("Mine save core glue is not loaded");
    expect(fetch).not.toHaveBeenCalled();
  });
});

// SPEC_CLIPPER.md, К4: the glue comes with the worker's code, the binary from
// disk, which an update replaces. Keeping the binary across worker restarts
// needs IndexedDB and is checked in Chromium (test:clipper-worker).
describe("the save core binary is of the glue's build", () => {
  const extensionBuild = read("./extensionBuild.js").toString();

  /// A worker of build `running` whose files on disk name, read after read,
  /// the builds in `disk`.
  function builtWorker(running: string, disk: string[]) {
    const reads: string[] = [];
    const session: Record<string, unknown> = {};
    const fetch = vi.fn(async (path: string) => {
      reads.push(path);
      if (path.endsWith("dist/runtime-identity.json")) {
        const buildId = disk.length > 1 ? disk.shift() : disk[0];
        return { ok: true, json: async () => ({ buildId, commit: "c" }) };
      }
      return { ok: true, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) };
    });
    const context = createContext({ TextDecoder, TextEncoder, URL, fetch,
      MineBuildIdentity: { buildId: running, commit: "c" },
      chrome: {
        runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
        storage: {
          local: { get: async () => ({}) },
          session: { set: async (values: Record<string, unknown>) => { Object.assign(session, values); } },
        },
      },
    });
    runInContext(glue, context, { filename: "mine_core.js" });
    runInContext(extensionBuild, context, { filename: "extensionBuild.js" });
    runInContext(adapter, context, { filename: "mineCore.js" });
    const call = () => runInContext(`MineCore.call({op:"layout", layout:{cards:"",media:"",collections:""}})`, context) as Promise<unknown>;
    return { call, reads, session };
  }

  it("reads the binary while the files on disk are of the running build, and checks them again after", async () => {
    const core = builtWorker("b1", ["b1"]);
    await expect(core.call()).resolves.toEqual({ cards: "", media: "", collections: "" });
    expect(core.reads).toEqual([
      "chrome-extension://test/dist/runtime-identity.json",
      "chrome-extension://test/generated/save-core/mine_core_bg.wasm",
      "chrome-extension://test/dist/runtime-identity.json",
    ]);
  });

  it("refuses the binary of another build and makes the reload into it pending", async () => {
    const core = builtWorker("b1", ["b2"]);
    await expect(core.call()).rejects.toMatchObject({ code: "extension_updated" });
    expect(core.reads.some((path) => path.endsWith(".wasm"))).toBe(false);
    expect(core.session.mineReloadPending).toBe("b2");
  });

  it("refuses a binary read while an update replaced the files", async () => {
    const core = builtWorker("b1", ["b1", "b2"]);
    await expect(core.call()).rejects.toMatchObject({ code: "extension_updated" });
    expect(core.session.mineReloadPending).toBe("b2");
  });
});
