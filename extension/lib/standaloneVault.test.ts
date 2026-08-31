// Real compiled Rust/WASM + deterministic platform adapter. These tests do
// not claim to model FSA's external-writer or power-loss guarantees.
import { createRequire } from "node:module";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./standaloneVault.js";

const wasm = createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js");
const call = async (command: unknown) => {
  const result = JSON.parse(wasm.execute_json(JSON.stringify(command)));
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
};
type Reply = { ok: boolean; outcome?: string; code?: string; slug?: string; tag?: string; resumable?: boolean; channels?: { tag: string }[] };
type Options = { directory: FakeDirectory; store: MemoryStore; binding_id?: string;
  fetch?: unknown; afterEffect?: (effect: string) => void; afterPrepared?: () => void };
const vault = (globalThis as unknown as { MineStandaloneVault: {
  saveStandaloneBlock: (request: Record<string, unknown>, options: Options) => Promise<Reply>;
  lookupOperation: (id: string, binding: string, options: Options) => Promise<Reply>;
  createStandaloneChannel: (tag: string, options: Options) => Promise<Reply>;
  listStandaloneChannels: (options: Options) => Promise<Reply>;
  resolveLayout: (directory: FakeDirectory) => Promise<unknown>;
  getStandaloneStatus: (options: Options) => Promise<unknown>;
} }).MineStandaloneVault;

class MemoryStore {
  values = new Map<string, unknown>();
  async get(store: string, key: string) { return structuredClone(this.values.get(`${store}:${key}`)); }
  async put(store: string, key: string, value: unknown) { this.values.set(`${store}:${key}`, structuredClone(value)); }
}
class FakeFile {
  blob: NodeBlob;
  constructor(content = "") { this.blob = new NodeBlob([content]); }
  async getFile() { return this.blob; }
  async createWritable() {
    let pending = new NodeBlob();
    return {
      write: async (content: string | NodeBlob) => { pending = new NodeBlob([content]); },
      close: async () => { this.blob = pending; },
      abort: async () => undefined,
    };
  }
}
class FakeDirectory {
  kind = "directory";
  files = new Map<string, FakeFile>();
  directories = new Map<string, FakeDirectory>();
  permission = "granted";
  constructor(public name: string) {}
  async queryPermission() { return this.permission; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    if (name.includes("/")) throw new TypeError("FSA requires one segment");
    if (!this.directories.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.directories.set(name, new FakeDirectory(name));
    }
    return this.directories.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (name.includes("/")) throw new TypeError("FSA requires one segment");
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.files.set(name, new FakeFile());
    }
    return this.files.get(name)!;
  }
  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
    for (const [name, dir] of this.directories) yield [name, dir];
  }
  async text(path: string): Promise<string> {
    const parts = path.split("/");
    let dir: FakeDirectory = this;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
  }
}
let folder: FakeDirectory;
let store: MemoryStore;
const options = (): Options => ({ directory: folder, store });
const request = (extra = {}) => ({ operation_id: "save-1", binding_id: "test-vault", executor_id: "browser",
  block_type: "article", title: "Article", body: "Content", tags: ["Collections/Reference"],
  saved_at: "2026-08-31T12:00:00Z", ...extra });
beforeEach(() => {
  folder = new FakeDirectory("Mine"); store = new MemoryStore();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("MineCore", { call });
});

describe("browser executor backed by actual WASM", () => {
  it("writes canonical Markdown and shared collection references", async () => {
    expect(await vault.saveStandaloneBlock(request(), options())).toMatchObject({ ok: true, slug: "Cards/Article" });
    const markdown = await folder.text("Cards/Article.md");
    expect(markdown).toContain("# Article\n\nContent");
    expect(markdown).toContain("[[Collections/Reference]]");
    expect(markdown).not.toContain("type:"); expect(markdown).not.toContain("title:");
  });
  it("walks nested configured folders one segment at a time", async () => {
    const mine = await folder.getDirectoryHandle(".mine", { create: true });
    mine.files.set("layout.json", new FakeFile(JSON.stringify({ cards: "Mine/Notes", media: "Mine/Files", collections: "Mine/Sets" })));
    expect(await vault.saveStandaloneBlock(request(), options())).toMatchObject({ ok: true, slug: "Mine/Notes/Article" });
    expect(await folder.text("Mine/Notes/Article.md")).toContain("Content");
  });
  it("does not hide invalid stored layout behind defaults", async () => {
    const mine = await folder.getDirectoryHandle(".mine", { create: true });
    mine.files.set("layout.json", new FakeFile('{"cards":"../outside","media":"Media","collections":"Collections"}'));
    expect(await vault.saveStandaloneBlock(request(), options())).toMatchObject({ ok: false, code: "invalid_path" });
    expect(folder.directories.size).toBe(1);
  });
  it("serializes concurrent extension saves and selects a free name", async () => {
    const replies = await Promise.all([vault.saveStandaloneBlock(request(), options()),
      vault.saveStandaloneBlock(request({ operation_id: "save-2" }), options())]);
    expect(replies.map(reply => reply.slug)).toEqual(["Cards/Article", "Cards/Article (2)"]);
  });
  it("replays compact receipt without rewriting a user-edited document", async () => {
    const first = await vault.saveStandaloneBlock(request(), options());
    folder.directories.get("Cards")!.files.set("Article.md", new FakeFile("User edit"));
    expect(await vault.saveStandaloneBlock(request(), options())).toEqual(first);
    expect(await folder.text("Cards/Article.md")).toBe("User edit");
    expect(await store.get("operations", "save-1")).not.toHaveProperty("markdown");
  });
  it("rejects identity reuse with another payload", async () => {
    await vault.saveStandaloneBlock(request(), options());
    expect(await vault.saveStandaloneBlock(request({ body: "Other" }), options())).toMatchObject({ ok: false, code: "operation_conflict" });
    expect(folder.directories.get("Cards")!.files.size).toBe(1);
  });
  it("recovers a closed Markdown file after losing the response", async () => {
    expect(await vault.saveStandaloneBlock(request(), { ...options(), afterEffect: () => { throw new Error("worker stopped"); } }))
      .toMatchObject({ ok: false, outcome: "unknown" });
    expect(await vault.lookupOperation("save-1", "test-vault", options())).toMatchObject({ ok: true, outcome: "committed" });
    expect(folder.directories.get("Cards")!.files.size).toBe(1);
  });
  it("resumes a prepared operation after worker restart", async () => {
    await vault.saveStandaloneBlock(request(), { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    expect(await vault.lookupOperation("save-1", "test-vault", options())).toMatchObject({ resumable: true });
    expect(await vault.saveStandaloneBlock(request({ operation_mode: "resume" }), options())).toMatchObject({ ok: true });
  });
  it("does not recreate a file missing after publication intent", async () => {
    await vault.saveStandaloneBlock(request(), { ...options(), afterEffect: () => { throw new Error("worker stopped"); } });
    folder.directories.get("Cards")!.files.delete("Article.md");
    expect(await vault.saveStandaloneBlock(request({ operation_mode: "resume" }), options())).toMatchObject({ outcome: "unknown" });
    expect(folder.directories.get("Cards")!.files.size).toBe(0);
  });
  it("does not start a fresh operation when its journal was lost", async () => {
    expect(await vault.saveStandaloneBlock(request({ operation_mode: "resume" }), options())).toMatchObject({ outcome: "unknown" });
    expect(folder.directories.size).toBe(0);
  });
  it("requires permission without calling another executor", async () => {
    folder.permission = "prompt";
    expect(await vault.saveStandaloneBlock(request(), options())).toMatchObject({ code: "permission_required", outcome: "not_committed" });
    expect(folder.directories.size).toBe(0);
  });
  it("does not mistake another same-name folder for the original binding", async () => {
    await vault.saveStandaloneBlock(request(), { ...options(), afterPrepared: () => { throw new Error("stop"); } });
    const other = new FakeDirectory("Mine");
    expect(await vault.saveStandaloneBlock(request({ operation_mode: "resume", binding_id: "other" }),
      { directory: other, store, binding_id: "other" })).toMatchObject({ code: "binding_mismatch" });
    expect(other.directories.size).toBe(0);
  });
  it("preserves a known foreign target that appeared after preparation", async () => {
    await vault.saveStandaloneBlock(request(), { ...options(), afterPrepared: () => { throw new Error("stop"); } });
    (await folder.getDirectoryHandle("Cards", { create: true })).files.set("Article.md", new FakeFile("Foreign"));
    expect(await vault.saveStandaloneBlock(request({ operation_mode: "resume" }), options())).toMatchObject({ code: "name_conflict" });
    expect(await folder.text("Cards/Article.md")).toBe("Foreign");
  });
  it("publishes media before its reference and recovers without downloading twice", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, blob: async () => new NodeBlob(["image"], { type: "image/png" }) }));
    const image = request({ block_type: "image", body: "", image_url: "https://example.com/image.png" });
    await vault.saveStandaloneBlock(image, { ...options(), fetch: fetcher, afterEffect: effect => { if (effect === "media") throw new Error("stop"); } });
    expect(await folder.text("Media/Article.png")).toBe("image");
    expect(folder.directories.get("Cards")!.files.size).toBe(0);
    expect(await vault.saveStandaloneBlock({ ...image, operation_mode: "resume" }, options())).toMatchObject({ ok: true });
    expect(await folder.text("Cards/Article.md")).toContain("[[Media/Article.png]]");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("lists only parsed collection documents, including a flat vault", async () => {
    folder.files.set("Note.md", new FakeFile("Plain note"));
    expect(await vault.createStandaloneChannel("Reference", options())).toMatchObject({ ok: true, tag: "Reference" });
    expect(await vault.listStandaloneChannels(options())).toMatchObject({ ok: true, channels: [{ tag: "Reference" }] });
  });
  it("exposes the real browser guarantee profile", async () => {
    expect(await vault.getStandaloneStatus(options())).toMatchObject({ configured: true, bindingId: "test-vault",
      capabilities: { atomic_no_clobber: false, durable_flush: false } });
  });
});
