// A failure of the folder itself reaches the clipper as `storage_error`: the
// reply's `code` is a string the clipper compares, never the numeric legacy
// `code` every DOMException carries (QuotaExceededError's is 22).
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import "./saveProtocol.js";
import "./standaloneVault.js";

const wasm: { execute_json(input: string): string } =
  createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js");
const call = async (command: unknown) => {
  const result: { ok: true; value: unknown } | { ok: false; error: { message: string; code: string } } =
    JSON.parse(wasm.execute_json(JSON.stringify(command)));
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
};

class MemoryStore {
  values = new Map<string, unknown>();
  async get(store: string, key: string) { return structuredClone(this.values.get(`${store}:${key}`)); }
  async put(store: string, key: string, value: unknown) { this.values.set(`${store}:${key}`, structuredClone(value)); }
}

// A folder on a full disk: it lists and creates entries, and refuses every write.
class FullFolder {
  kind = "directory" as const;
  directories = new Map<string, FullFolder>();
  files = new Set<string>();
  async queryPermission() { return "granted" as const; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FullFolder> {
    let folder = this.directories.get(name);
    if (!folder) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      folder = new FullFolder();
      this.directories.set(name, folder);
    }
    return folder;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.files.add(name);
    }
    return {
      createWritable: async () => ({
        write: async () => { throw new DOMException("The disk is full", "QuotaExceededError"); },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
  }
  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files) yield [name, { kind: "file" }];
    for (const [name, folder] of this.directories) yield [name, folder];
  }
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("MineCore", { call });
});

it("answers a refused folder write with storage_error, not the DOMException's numeric code", async () => {
  const folder = new FullFolder();
  const reply = await globalThis.MineStandaloneVault.saveStandaloneBlock(
    { operation_id: "save-1", binding_id: "test-vault", executor_id: "browser", block_type: "article",
      title: "Article", body: "Content", tags: [], saved_at: "2026-10-13T12:00:00" },
    // The fake holds only the File System Access calls the adapter makes.
    { directory: folder as unknown as FileSystemDirectoryHandle, store: new MemoryStore() },
  );
  expect(reply).toMatchObject({ ok: false, outcome: "not_committed", code: "storage_error", error: "The disk is full" });
});
