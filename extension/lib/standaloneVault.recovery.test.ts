// Independent recovery regressions: real Rust/WASM and in-memory IO only.
// The fake handles do not model OS no-clobber or power-loss guarantees.
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./standaloneVault.js";

const wasm = createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js");
async function call(command: unknown) {
  const response = JSON.parse(wasm.execute_json(JSON.stringify(command)));
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response.value;
}

class Journal {
  records = new Map<string, unknown>();
  afterPut?: (store: string, value: Record<string, unknown>) => void;
  async get(store: string, key: string) { return structuredClone(this.records.get(`${store}:${key}`)); }
  async put(store: string, key: string, value: Record<string, unknown>) {
    this.records.set(`${store}:${key}`, structuredClone(value));
    this.afterPut?.(store, value);
  }
}

class FileHandle {
  blob: NodeBlob;
  constructor(content = "") { this.blob = new NodeBlob([content]); }
  async getFile() { return this.blob; }
  async createWritable() {
    let pending = this.blob;
    return {
      write: async (bytes: string | NodeBlob) => { pending = new NodeBlob([bytes]); },
      close: async () => { this.blob = pending; },
      abort: async () => undefined,
    };
  }
}

class DirectoryHandle {
  kind = "directory";
  permission = "granted";
  failNextDirectory: string | null = null;
  files = new Map<string, FileHandle>();
  directories = new Map<string, DirectoryHandle>();
  constructor(public name: string) {}
  async queryPermission() { return this.permission; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle> {
    if (name.includes("/")) throw new TypeError("FSA requires one path segment");
    if (options?.create && name === this.failNextDirectory) {
      this.failNextDirectory = null;
      throw new DOMException("interrupted directory initialization", "NotAllowedError");
    }
    if (!this.directories.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.directories.set(name, new DirectoryHandle(name));
    }
    return this.directories.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (name.includes("/")) throw new TypeError("FSA requires one path segment");
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.files.set(name, new FileHandle());
    }
    return this.files.get(name)!;
  }
  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
    for (const [name, directory] of this.directories) yield [name, directory];
  }
  async text(path: string): Promise<string> {
    const pieces = path.split("/");
    let directory: DirectoryHandle = this;
    for (const piece of pieces.slice(0, -1)) directory = await directory.getDirectoryHandle(piece);
    return (await (await directory.getFileHandle(pieces.at(-1)!)).getFile()).text();
  }
}

type Reply = { ok: boolean; outcome?: string; code?: string; slug?: string; terminal_rejected?: boolean; resumable?: boolean };
type Options = {
  directory: DirectoryHandle;
  store: Journal;
  binding_id?: string;
  fetch?: unknown;
  afterPrepared?: () => void;
  afterEffect?: (effect: string) => void;
};
const adapter = (globalThis as unknown as { MineStandaloneVault: {
  saveStandaloneBlock(request: Record<string, unknown>, options: Options): Promise<Reply>;
  lookupOperation(id: string, binding: string, options: Options): Promise<Reply>;
} }).MineStandaloneVault;
const timestamp = "2026-08-31T12:34:56Z";
const request = (extra = {}) => ({ operation_id: "recovery-1", binding_id: "test-vault", executor_id: "browser",
  block_type: "article", title: "Original", body: "Original material", tags: [], saved_at: timestamp, ...extra });
const image = (extra = {}) => request({ block_type: "image", body: "", image_url: "https://example.com/photo.png", ...extra });
const fetchImage = async () => ({ ok: true, blob: async () => new NodeBlob(["image bytes"], { type: "image/png" }) });
let folder: DirectoryHandle;
let journal: Journal;
const options = (): Options => ({ directory: folder, store: journal, fetch: fetchImage });
beforeEach(() => {
  folder = new DirectoryHandle("Mine");
  journal = new Journal();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("MineCore", { call });
});

describe("standalone recovery invariants", () => {
  it.each(["foreign bytes", "image bytes"])("rejects a Prepared media conflict (%s) durably and permits an explicit new save", async foreign => {
    for (const name of ["Cards", "Media", "Collections"]) await folder.getDirectoryHandle(name, { create: true });
    await adapter.saveStandaloneBlock(image(), { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    const media = await folder.getDirectoryHandle("Media", { create: true });
    media.files.set("Original.png", new FileHandle(foreign));
    const rejected = await adapter.lookupOperation("recovery-1", "test-vault", options());
    expect(rejected).toMatchObject({ code: "name_conflict", outcome: "not_committed", terminal_rejected: true });
    expect(await adapter.saveStandaloneBlock(image({ operation_mode: "resume" }), options())).toEqual(rejected);
    expect(await journal.get("operations", "recovery-1")).toMatchObject({ phase: "rejected", markdown: expect.any(String), media: { blob: expect.anything() } });
    expect(await folder.text("Media/Original.png")).toBe(foreign);
    expect(folder.directories.get("Cards")?.files.size ?? 0).toBe(0);
    expect(await adapter.saveStandaloneBlock(image({ operation_id: "explicit-retry" }), options())).toMatchObject({ ok: true, slug: "Cards/Original (2)" });
    expect(await folder.text("Cards/Original (2).md")).toContain("[[Media/Original (2).png]]");
    expect(await folder.text("Media/Original.png")).toBe(foreign);
  });

  it("rejects a Prepared Markdown conflict without deleting the body and permits explicit retry", async () => {
    for (const name of ["Cards", "Media", "Collections"]) await folder.getDirectoryHandle(name, { create: true });
    await adapter.saveStandaloneBlock(request(), { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    folder.directories.get("Cards")!.files.set("Original.md", new FileHandle("Foreign content"));
    const rejected = await adapter.saveStandaloneBlock(request({ operation_mode: "resume" }), options());
    expect(rejected).toMatchObject({ code: "name_conflict", outcome: "not_committed", terminal_rejected: true });
    expect(await adapter.lookupOperation("recovery-1", "test-vault", options())).toEqual(rejected);
    expect(await journal.get("operations", "recovery-1")).toMatchObject({ phase: "rejected", markdown: expect.stringContaining("Original material") });
    expect(await adapter.saveStandaloneBlock(request({ operation_id: "explicit-retry" }), options())).toMatchObject({ ok: true, slug: "Cards/Original (2)" });
    expect(await folder.text("Cards/Original.md")).toBe("Foreign content");
    expect(await folder.text("Cards/Original (2).md")).toContain("Original material");
  });

  it("does not call a conflict terminal after media publication began", async () => {
    await adapter.saveStandaloneBlock(image(), { ...options(), afterEffect: effect => { if (effect === "media") throw new Error("worker stopped"); } });
    folder.directories.get("Cards")!.files.set("Original.md", new FileHandle("Foreign content"));
    const result = await adapter.lookupOperation("recovery-1", "test-vault", options());
    expect(result).toMatchObject({ outcome: "unknown" });
    expect(result.terminal_rejected).not.toBe(true);
    expect(await adapter.saveStandaloneBlock(image({ operation_mode: "resume" }), options())).toMatchObject({ outcome: "unknown" });
    expect(await journal.get("operations", "recovery-1")).toMatchObject({ phase: "media_publishing", media: { blob: expect.anything() } });
    expect(await folder.text("Media/Original.png")).toBe("image bytes");
    expect(await folder.text("Cards/Original.md")).toBe("Foreign content");
  });

  it("does not recreate media that disappeared after MediaPublished", async () => {
    journal.afterPut = (store, value) => {
      if (store === "operations" && value.phase === "media_published") throw new Error("worker stopped after durable transition");
    };
    await adapter.saveStandaloneBlock(image(), options());
    expect(await journal.get("operations", "recovery-1")).toMatchObject({ phase: "media_published" });
    journal.afterPut = undefined;
    folder.directories.get("Media")!.files.delete("Original.png");
    expect(await adapter.lookupOperation("recovery-1", "test-vault", options())).toMatchObject({ outcome: "unknown" });
    expect(await adapter.saveStandaloneBlock(image({ operation_mode: "resume" }), options())).toMatchObject({ outcome: "unknown" });
    expect(folder.directories.get("Media")!.files.size).toBe(0);
    expect(folder.directories.get("Cards")!.files.size).toBe(0);
  });

  it("passes prepared metadata and explicit media references to the same capture constructor", async () => {
    const metadata = { description: "An image description", width: 640, height: 480, author: "Author" };
    const capture = image(metadata);
    expect(await adapter.saveStandaloneBlock(capture, options())).toMatchObject({ ok: true });
    const canonical = await call({ op: "capture", request: {
      slug: "Cards/Original", block_type: "image", title: "Original", description: metadata.description,
      url: null, body: "", file: "Media/Original.png", thumbnail: null, tags: [], saved_at: timestamp,
      source: "web-clipper", width: metadata.width, height: metadata.height, author: metadata.author,
    } });
    expect(await folder.text("Cards/Original.md")).toBe(canonical.markdown);
  });

  it("recovers a terminal pre-effect rejection without dispatching the request again", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 503 }));
    const rejected = await adapter.saveStandaloneBlock(image(), { ...options(), fetch: fetcher });
    expect(rejected).toMatchObject({ outcome: "not_committed", code: "download_failed", terminal_rejected: true });
    expect(await adapter.lookupOperation("recovery-1", "test-vault", options())).toEqual(rejected);
    expect(await adapter.saveStandaloneBlock(image({ operation_mode: "resume" }), options())).toEqual(rejected);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(folder.directories.size).toBe(0);
  });

  it("retains the prepared material when permission is revoked and resumes it after regrant", async () => {
    await adapter.saveStandaloneBlock(request(), { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    folder.permission = "prompt";
    expect(await adapter.lookupOperation("recovery-1", "test-vault", options())).toMatchObject({ outcome: "unknown", code: "permission_required" });
    expect(await journal.get("operations", "recovery-1")).toHaveProperty("markdown", expect.stringContaining("Original material"));
    folder.permission = "granted";
    expect(await adapter.lookupOperation("recovery-1", "test-vault", options())).toMatchObject({ resumable: true });
    expect(await adapter.saveStandaloneBlock(request({ operation_mode: "resume" }), options())).toMatchObject({ ok: true });
    expect(await folder.text("Cards/Original.md")).toContain("Original material");
  });

  it("does not compact the only body while published bytes cannot be confirmed", async () => {
    await adapter.saveStandaloneBlock(request(), { ...options(), afterEffect: () => { throw new Error("response lost"); } });
    folder.directories.get("Cards")!.files.set("Original.md", new FileHandle("Changed externally"));
    expect(await adapter.lookupOperation("recovery-1", "test-vault", options())).toMatchObject({ outcome: "unknown" });
    expect(await journal.get("operations", "recovery-1")).toMatchObject({ phase: "markdown_publishing", markdown: expect.stringContaining("Original material") });
    expect(await folder.text("Cards/Original.md")).toBe("Changed externally");
  });

  it("keeps the chosen standard layout after partial directory initialization", async () => {
    folder.failNextDirectory = "Media";
    expect(await adapter.saveStandaloneBlock(request(), options())).toMatchObject({ ok: false });
    expect(folder.directories.has("Cards")).toBe(true);
    expect(folder.directories.has("Collections")).toBe(false);
    const next = request({ operation_id: "recovery-2", title: "Next" });
    expect(await adapter.saveStandaloneBlock(next, options())).toMatchObject({ ok: true, slug: "Cards/Next" });
    expect(await folder.text("Cards/Next.md")).toContain("Original material");
    expect(folder.files.has("Next.md")).toBe(false);
  });
});
