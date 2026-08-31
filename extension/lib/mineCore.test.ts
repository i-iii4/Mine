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

  it("reports missing generated glue explicitly", async () => {
    const { context, fetch } = worker(false, false);
    await expect(runInContext(`MineCore.call({op:"fingerprint",value:"{}"})`, context))
      .rejects.toThrow("Mine save core glue is not loaded");
    expect(fetch).not.toHaveBeenCalled();
  });
});
