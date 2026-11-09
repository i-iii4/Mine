// SPEC_CLIPPER.md, «Один путь файла со страницы», Б13: the browser folder keeps
// the media of a clip as files, the same result as with the helper. The real
// standaloneVault.js, pageFiles.js and Rust/WASM over a stand-in folder, journal
// and network; a real folder through the system picker is the live acceptance.
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./browserFile.js";
import "./pageFiles.js";
import "./saveProtocol.js";
import "./standaloneVault.js";
import type { BrowserFileEntry, FileAnswer, PageFile, PageFileWork } from "./pageFiles.types";
import type { PageFileAnswer } from "./browserFile.types";

const wasm = createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js");
const call = async (command: unknown) => {
  const result = JSON.parse(wasm.execute_json(JSON.stringify(command)));
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, ...(typeof result.error.collection === "string" ? { collection: result.error.collection } : {}) });
  return result.value;
};

const PAGE = "https://shop.example.com/articles/1";
const PICTURE = "https://shop.example.com/a.jpg";
const SECOND = "https://cdn.example.net/b.jpg";
const THIRD = "https://cdn.example.net/c.jpg";
const VIDEO = "https://cdn.example.net/v.mp4";
const POSTER = "https://cdn.example.net/poster.jpg";

const JPEG = (mark: string) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(mark)]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Reply = {
  ok: boolean; outcome?: string; code?: string; error?: string; slug?: string; warning?: string;
  terminal_rejected?: boolean; resumable?: boolean; remote_media?: unknown[]; media_reasons?: unknown[];
};
type Options = { directory: FakeDirectory; store: MemoryStore; afterEffect?: (effect: string) => void; afterPrepared?: () => void };
type Collection = Pick<PageFileWork, "signal" | "limiter" | "pageRead" | "request"> & { stored: (id: string) => void };
// The adapter as these tests drive it: its folder and journal are the fakes
// below, which hold only the File System Access and IndexedDB calls it makes.
const vault = (globalThis as unknown as { MineStandaloneVault: {
  saveStandaloneBlock(request: Record<string, unknown>, options: Options): Promise<Reply>;
  lookupOperation(id: string, binding: string, options: Options): Promise<Reply>;
  collectPageFiles(request: Record<string, unknown>, work: Collection, options: Options): Promise<BrowserFileEntry[]>;
  discardPageFiles(ids: string[], options: Options): Promise<void>;
  sweepPageFiles(names: () => Promise<string[]>, options: Options): Promise<void>;
} }).MineStandaloneVault;
const { createLimiter, requestFile } = globalThis.MinePageFiles;

class MemoryStore {
  values = new Map<string, unknown>();
  refuse: ((store: string) => boolean) | null = null;
  async get(store: string, key: string) { return structuredClone(this.values.get(`${store}:${key}`)); }
  async put(store: string, key: string, value: unknown) {
    if (this.refuse?.(store)) throw new DOMException("the disk is full", "QuotaExceededError");
    this.values.set(`${store}:${key}`, structuredClone(value));
  }
  async delete(store: string, key: string) { this.values.delete(`${store}:${key}`); }
  async all(store: string) {
    return [...this.values].filter(([key]) => key.startsWith(`${store}:`)).map(([, value]) => structuredClone(value));
  }
  /** The ids of the kept files. */
  kept() { return [...this.values.keys()].filter((key) => key.startsWith("page_files:")); }
}

/** Every file the folder wrote, in the order they closed. */
let written: string[] = [];
class FakeFile {
  blob: NodeBlob;
  reads = 0;
  constructor(public path: string, content: string | NodeBlob = "") { this.blob = new NodeBlob([content]); }
  async getFile() {
    this.reads += 1;
    return new NodeFile([this.blob], "file");
  }
  async createWritable() {
    let pending = new NodeBlob([]);
    return {
      write: async (content: string | NodeBlob) => { pending = new NodeBlob([content]); },
      close: async () => { this.blob = pending; written.push(this.path); },
      abort: async () => undefined,
    };
  }
}
class FakeDirectory {
  kind = "directory";
  files = new Map<string, FakeFile>();
  directories = new Map<string, FakeDirectory>();
  constructor(public name: string, public path = "") {}
  async queryPermission() { return "granted"; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    if (!this.directories.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.directories.set(name, new FakeDirectory(name, `${this.path}${name}/`));
    }
    return this.directories.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.files.set(name, new FakeFile(`${this.path}${name}`));
    }
    return this.files.get(name)!;
  }
  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
    for (const [name, directory] of this.directories) yield [name, directory];
  }
  async text(path: string): Promise<string> {
    const [first, ...rest] = path.split("/");
    if (rest.length > 0) return (await this.getDirectoryHandle(first!)).text(rest.join("/"));
    return (await (await this.getFileHandle(first!)).getFile()).text();
  }
  names(folder = "Media") { return [...(this.directories.get(folder)?.files.keys() ?? [])].sort(); }
}

let folder: FakeDirectory;
let store: MemoryStore;
const options = (): Options => ({ directory: folder, store });
const request = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  operation_id: "clip-1", binding_id: "test-vault", executor_id: "browser", block_type: "article",
  title: "Article", url: PAGE, tags: [], saved_at: "2026-11-06T12:00:00", ...extra,
});

/** An answer of the stand-in network. */
const answer = (body: Uint8Array | string, type = "image/jpeg", status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : Buffer.from(body), { status, headers: { "content-type": type, ...headers } });
type Site = Record<string, (init?: RequestInit) => Response | Promise<Response>>;

/** The stand-in network: who was asked for what. */
function network(site: Site) {
  const asked: string[] = [];
  const fetchFile = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    const respond = site[url];
    if (!respond) throw new TypeError("Failed to fetch");
    return respond(init);
  });
  return { asked, fetchFile: fetchFile as unknown as typeof fetch };
}
const count = (asked: string[], url: string) => asked.filter((entry) => entry === url).length;

type PageScene = Record<string, { cache?: PageFileAnswer | FileAnswer; request?: PageFileAnswer | FileAnswer }>;

/** The collection on the port, over the stand-in page and network. */
function collection(fetchFile: typeof fetch, page: PageScene = {}, signal = new AbortController().signal) {
  const stored: string[] = [];
  const work: Collection = {
    signal,
    limiter: createLimiter(),
    pageRead: async (url, mode) => {
      const on = page[url];
      if (!on) return { kind: "elsewhere" };
      return on[mode] ?? { kind: "miss" };
    },
    request: (file: PageFile) => requestFile(file, {
      signal, idleMs: 30, fetchFile,
      addRefererRule: async () => null,
      removeRefererRule: async () => undefined,
    }),
    stored: (id) => stored.push(id),
  };
  return { work, stored };
}

/** The request after its collection, as the clipper fixes it. */
async function collected(extra: Record<string, unknown>, fetchFile: typeof fetch, page: PageScene = {}) {
  const clip = request(extra);
  const { work } = collection(fetchFile, page);
  const browser_files = await vault.collectPageFiles({
    document_url: PAGE, body: clip.body ?? null, image_url: clip.image_url ?? null, video_posters: clip.video_posters ?? null,
  }, work, options());
  return { ...clip, browser_files };
}
const fromPage = (body: Uint8Array, source: "cache" | "page" = "cache"): FileAnswer =>
  ({ kind: "file", blob: new Blob([Buffer.from(body)], { type: "image/jpeg" }), source, finalUrl: PICTURE });

beforeEach(() => {
  folder = new FakeDirectory("Mine");
  store = new MemoryStore();
  written = [];
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("MineCore", { call });
  vi.stubGlobal("Blob", NodeBlob);
});

describe("table Б13, row by row", () => {
  it("a file of the page's cache costs no request and lands in the media folder", async () => {
    const { asked, fetchFile } = network({});
    const clip = await collected({ body: `![a](${PICTURE})` }, fetchFile, { [PICTURE]: { cache: fromPage(JPEG("cached")) } });
    expect(clip.browser_files).toEqual([{ url: PICTURE, upload_id: expect.any(String), source: "cache" }]);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, outcome: "committed", remote_media: [] });
    expect(asked).toEqual([]);
    expect(folder.names()).toEqual(["Article (image 1).jpg"]);
    const markdown = await folder.text("Cards/Article.md");
    expect(markdown).toContain("![[Article (image 1).jpg|a]]");
    expect(markdown).not.toContain(PICTURE);
  });

  it("a file the browser requested costs one request", async () => {
    const { asked, fetchFile } = network({ [SECOND]: () => answer(JPEG("second")) });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, remote_media: [] });
    expect(count(asked, SECOND)).toBe(1);
    expect(await folder.text("Media/Article (image 1).jpg")).toBe(await new NodeBlob([JPEG("second")]).text());
  });

  it("a 429 leaves a link, and the next files of that host are not asked for", async () => {
    // Two requests to one host at once: the second is under way when the first
    // is refused, and the third is the next file.
    const FOURTH = "https://cdn.example.net/d.jpg";
    const { asked, fetchFile } = network({
      [SECOND]: () => answer("", "text/plain", 429, { "retry-after": "600" }),
      [THIRD]: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return answer(JPEG("third")); },
      [FOURTH]: () => answer(JPEG("fourth")),
    });
    const clip = await collected({ body: `![b](${SECOND})\n\n![c](${THIRD})\n\n![d](${FOURTH})` }, fetchFile);
    const saved = await vault.saveStandaloneBlock(clip, options());
    expect(saved).toMatchObject({ ok: true, remote_media: [
      { url: SECOND, kind: "image", reason: "download_failed" },
      { url: FOURTH, kind: "image", reason: "download_failed" },
    ] });
    expect(count(asked, SECOND)).toBe(1);
    expect(count(asked, FOURTH)).toBe(0);
    const reason = "cdn.example.net is not giving the file right now (HTTP 429). Try again in 10 min.";
    expect(saved.media_reasons).toEqual([{ url: SECOND, reason }, { url: FOURTH, reason }]);
    expect(folder.names()).toEqual(["Article (image 2).jpg"]);
    const markdown = await folder.text("Cards/Article.md");
    expect(markdown).toContain(`![b](${SECOND})`);
    expect(markdown).toContain(`![d](${FOURTH})`);
  });

  it.each([
    ["404", () => answer("", "text/plain", 404), "cdn.example.net did not give the file (HTTP 404)."],
    ["410", () => answer("", "text/plain", 410), "cdn.example.net did not give the file (HTTP 410)."],
    ["another 4xx", () => answer("", "text/plain", 403), "cdn.example.net did not give the file (HTTP 403)."],
    ["text/html", () => answer("<html>Are you a robot?</html>", "text/html; charset=utf-8"), "cdn.example.net did not give the file: the answer is a web page."],
  ])("%s leaves a link after one request", async (_case, respond, reason) => {
    const { asked, fetchFile } = network({ [SECOND]: respond });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true,
      remote_media: [{ url: SECOND, kind: "image", reason: "download_failed" }],
      media_reasons: [{ url: SECOND, reason }] });
    expect(count(asked, SECOND)).toBe(1);
    expect(await folder.text("Cards/Article.md")).toContain(`![b](${SECOND})`);
  });

  it("a 5xx is asked for up to three times and gives the file when it comes", async () => {
    let attempts = 0;
    const { asked, fetchFile } = network({ [SECOND]: () => (++attempts < 3 ? answer("", "text/plain", 503) : answer(JPEG("late"))) });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(clip.browser_files).toEqual([expect.objectContaining({ url: SECOND, source: "browser" })]);
    expect(count(asked, SECOND)).toBe(3);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, remote_media: [] });
  });

  it("a 5xx that stays leaves a link after three requests", async () => {
    const { asked, fetchFile } = network({ [SECOND]: () => answer("", "text/plain", 502) });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(count(asked, SECOND)).toBe(3);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true,
      remote_media: [{ url: SECOND, kind: "image", reason: "download_failed" }],
      media_reasons: [{ url: SECOND, reason: "cdn.example.net did not give the file (HTTP 502)." }] });
  });

  it("a broken network is asked three times", async () => {
    const { asked, fetchFile } = network({});
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(count(asked, SECOND)).toBe(3);
    expect(clip.browser_files).toEqual([{ url: SECOND, failure: "no_answer" }]);
  });

  it("an answer without bytes runs out of its time and is asked three times", async () => {
    // Never a byte; like a real answer, the body breaks when the request stops.
    const stalled = (init?: RequestInit) => new Response(new ReadableStream({ start(body) {
      init?.signal?.addEventListener("abort", () => body.error(new DOMException("stopped", "AbortError")));
    } }), { headers: { "content-type": "image/jpeg" } });
    const { asked, fetchFile } = network({ [SECOND]: stalled });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(count(asked, SECOND)).toBe(3);
    expect(clip.browser_files).toEqual([{ url: SECOND, failure: "no_answer" }]);
  });

  it("a file over 500 MiB is not read, and its video takes the poster", async () => {
    const { asked, fetchFile } = network({
      [VIDEO]: () => answer(JPEG("too big"), "video/mp4", 200, { "content-length": String(500 * 1024 * 1024 + 1) }),
      [POSTER]: () => answer(JPEG("poster")),
    });
    const clip = await collected({ body: `![v](${VIDEO})`, video_posters: [{ video_url: VIDEO, poster_url: POSTER }] }, fetchFile);
    expect(clip.browser_files).toEqual([{ url: VIDEO, failure: "too_large" }, expect.objectContaining({ url: POSTER, upload_id: expect.any(String) })]);
    expect(count(asked, VIDEO)).toBe(1);
    const saved = await vault.saveStandaloneBlock(clip, options());
    expect(saved).toMatchObject({ ok: true, remote_media: [{ url: VIDEO, kind: "video", reason: "download_failed" }],
      media_reasons: [{ url: VIDEO, reason: "cdn.example.net did not give the file: the file is larger than 500 MiB." }] });
    expect(folder.names()).toEqual(["Article (poster).jpg"]);
    const markdown = await folder.text("Cards/Article.md");
    expect(markdown).toContain(`![v](${VIDEO})`);
    expect(markdown).toMatch(/thumbnail: .*Article \(poster\)\.jpg/);
  });

  it("the poster of a saved video is not asked for", async () => {
    const { asked, fetchFile } = network({ [VIDEO]: () => answer(JPEG("video"), "video/mp4"), [POSTER]: () => answer(JPEG("poster")) });
    const clip = await collected({ body: `![v](${VIDEO})`, video_posters: [{ video_url: VIDEO, poster_url: POSTER }] }, fetchFile);
    expect(count(asked, POSTER)).toBe(0);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, remote_media: [] });
    expect(folder.names().length).toBe(1);
  });

  it("an address that names a private network is not asked for, and stays a link with its reason", async () => {
    const inside = "http://nas.local/a.jpg";
    const { asked, fetchFile } = network({ [inside]: () => answer(JPEG("inside")) });
    const clip = await collected({ body: `![a](${inside})` }, fetchFile);
    expect(asked).toEqual([]);
    expect(clip.browser_files).toEqual([]);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true,
      remote_media: [{ url: inside, kind: "image", reason: "download_failed" }],
      media_reasons: [{ url: inside, reason: "nas.local did not give the file: the name has no known public suffix." }] });
  });

  it("the page itself may still give a file of its own address that names a private network (Б5)", async () => {
    const inside = "http://nas.local/own.jpg";
    const { asked, fetchFile } = network({});
    const clip = await collected({ body: `![a](${inside})` }, fetchFile, { [inside]: { request: fromPage(JPEG("own"), "page") } });
    expect(asked).toEqual([]);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, remote_media: [] });
    expect(folder.names()).toEqual(["Article (image 1).jpg"]);
  });

  it("a redirect that led to a private network does not make a file", async () => {
    const led = answer(JPEG("inside"));
    Object.defineProperty(led, "url", { value: "http://10.0.0.5/secret.jpg" });
    const { fetchFile } = network({ [SECOND]: () => led });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(clip.browser_files).toEqual([expect.objectContaining({ final_url: "http://10.0.0.5/secret.jpg" })]);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true,
      remote_media: [{ url: SECOND, kind: "image", reason: "download_failed" }],
      media_reasons: [{ url: SECOND, reason: "10.0.0.5 did not give the file: the address names this Mac or a private network." }] });
    expect(folder.names()).toEqual([]);
  });

  it("a file the browser's storage refuses stays a link with the reason not_stored", async () => {
    store.refuse = (name) => name === "page_files";
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("second")) });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    expect(clip.browser_files).toEqual([{ url: SECOND, failure: "not_stored" }]);
    store.refuse = null;
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true,
      media_reasons: [{ url: SECOND, reason: "cdn.example.net did not give the file: the browser could not keep the file." }] });
  });

  it("a file the collection never reached stays a link", async () => {
    const saved = await vault.saveStandaloneBlock(request({ body: `![b](${SECOND})`, browser_files: [] }), options());
    expect(saved).toMatchObject({ ok: true,
      media_reasons: [{ url: SECOND, reason: "cdn.example.net did not give the file: the browser did not ask for the file." }] });
    expect(await folder.text("Cards/Article.md")).toContain(`![b](${SECOND})`);
  });
});

describe("the same result as with the helper", () => {
  it("writes every file before the note", async () => {
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("two")), [THIRD]: () => answer(PNG, "image/png"), [POSTER]: () => answer(JPEG("og")) });
    const clip = await collected({ block_type: "link", image_url: POSTER, body: `![b](${SECOND})\n\n![c](${THIRD})` }, fetchFile);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, slug: "Cards/Article" });
    expect(written.at(-1)).toBe("Cards/Article.md");
    expect(written.filter((path) => path.startsWith("Media/")).sort()).toEqual(["Media/Article (image 1).jpg", "Media/Article (image 2).png", "Media/Article.jpg"]);
  });

  it("names a medium by its bytes", async () => {
    const { fetchFile } = network({ [SECOND]: () => answer(PNG, "image/jpeg") });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    await vault.saveStandaloneBlock(clip, options());
    expect(folder.names()).toEqual(["Article (image 1).png"]);
    expect(await folder.text("Cards/Article.md")).toContain("![[Article (image 1).png|b]]");
  });

  it("gives an address without a type the type of its answer, and the assumption of the helper in silence", async () => {
    const blob = "https://pds.example.org/xrpc/getBlob?cid=1";
    const silent = "https://pds.example.org/xrpc/getBlob?cid=2";
    const { fetchFile } = network({ [blob]: () => answer(JPEG("video bytes").slice(4), "video/mp4"), [silent]: () => new Response(Buffer.from("unknown bytes")) });
    const clip = await collected({ body: `![v](${blob})\n\n![s](${silent})` }, fetchFile);
    await vault.saveStandaloneBlock(clip, options());
    expect(folder.names()).toEqual(["Article (image 1).jpg", "Article (video 1).mp4"]);
  });

  it("makes a repeated address one file with both captions", async () => {
    const { asked, fetchFile } = network({ [SECOND]: () => answer(JPEG("same")) });
    const clip = await collected({ body: `![one](${SECOND})\n\n![two](${SECOND})` }, fetchFile);
    await vault.saveStandaloneBlock(clip, options());
    expect(count(asked, SECOND)).toBe(1);
    expect(folder.names()).toEqual(["Article (image 1).jpg"]);
    const markdown = await folder.text("Cards/Article.md");
    expect(markdown).toContain("![[Article (image 1).jpg|one]]");
    expect(markdown).toContain("![[Article (image 1).jpg|two]]");
  });

  it("keeps one file for the same bytes at two addresses, each place with its caption (Ф5)", async () => {
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("same")), [THIRD]: () => answer(JPEG("same")) });
    const clip = await collected({ body: `![one](${SECOND})\n\n![two](${THIRD})` }, fetchFile);
    await vault.saveStandaloneBlock(clip, options());
    expect(folder.names()).toEqual(["Article (image 1).jpg"]);
    const markdown = await folder.text("Cards/Article.md");
    expect(markdown).toContain("![[Article (image 1).jpg|one]]");
    expect(markdown).toContain("![[Article (image 1).jpg|two]]");
    expect(store.kept()).toEqual([]);
  });

  it("writes the picture of a video card as its thumbnail, not as its file", async () => {
    const { fetchFile } = network({ [POSTER]: () => answer(JPEG("preview")) });
    const clip = await collected({ block_type: "video", title: "Video", body: "", image_url: POSTER }, fetchFile);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true });
    const markdown = await folder.text("Cards/Video.md");
    expect(markdown).toMatch(/thumbnail: .*Video\.jpg/);
    expect(markdown).not.toMatch(/\nfile:/);
  });

  it.each(["link", "video"])("saves a %s without its preview and says why", async (block_type) => {
    const { fetchFile } = network({ [POSTER]: () => answer("", "text/plain", 404) });
    const clip = await collected({ block_type, image_url: POSTER, body: "Text" }, fetchFile);
    const saved = await vault.saveStandaloneBlock(clip, options());
    expect(saved).toMatchObject({ ok: true, warning: "cdn.example.net did not give the file (HTTP 404)." });
    expect(folder.names()).toEqual([]);
    expect(await folder.text("Cards/Article.md")).not.toMatch(/thumbnail|\nfile:/);
  });

  it("does not save a picture card without its file and names the reason (Б3)", async () => {
    const { fetchFile } = network({ [PICTURE]: () => answer("", "text/plain", 429, { "retry-after": "600" }) });
    const clip = await collected({ block_type: "image", body: "", image_url: PICTURE }, fetchFile);
    const refused = await vault.saveStandaloneBlock(clip, options());
    expect(refused).toMatchObject({ ok: false, outcome: "not_committed", terminal_rejected: true, code: "download_failed",
      error: "shop.example.com is not giving the file right now (HTTP 429). Try again in 10 min." });
    expect(folder.directories.size).toBe(0);
  });

  it("repeats remote_media and the reasons from the receipt", async () => {
    const { fetchFile } = network({ [SECOND]: () => answer("", "text/plain", 404) });
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    const saved = await vault.saveStandaloneBlock(clip, options());
    expect(saved.remote_media).toHaveLength(1);
    expect(await store.get("operations", "clip-1")).toMatchObject({ phase: "committed", remote_media: saved.remote_media, media_reasons: saved.media_reasons });
    expect(await vault.saveStandaloneBlock(clip, options())).toEqual(saved);
    expect(await vault.lookupOperation("clip-1", "test-vault", options())).toEqual(saved);
  });

  it("logs one line per file with where it came from, without headers", async () => {
    const line = vi.spyOn(console, "info");
    line.mockClear();
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("two")), [THIRD]: () => answer("", "text/plain", 404) });
    const clip = await collected({ body: `![b](${SECOND})\n\n![c](${THIRD})` }, fetchFile);
    await vault.saveStandaloneBlock(clip, options());
    const lines = line.mock.calls.map((call) => String(call[0])).filter((text) => text.includes("page-file:"));
    expect(lines).toEqual([
      `[Mine] page-file: ${SECOND} from browser`,
      `[Mine] page-file: ${THIRD} from link: cdn.example.net did not give the file (HTTP 404).`,
    ]);
  });
});

describe("the journal", () => {
  async function prepared() {
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("two")), [THIRD]: () => answer(JPEG("three")) });
    return collected({ body: `![b](${SECOND})\n\n![c](${THIRD})` }, fetchFile);
  }

  it("holds a list of files without their bytes", async () => {
    const clip = await prepared();
    await vault.saveStandaloneBlock(clip, { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    const record = await store.get("operations", "clip-1") as { phase: string; files: Record<string, unknown>[]; media?: unknown };
    expect(record.phase).toBe("prepared");
    expect(record.media).toBeUndefined();
    expect(record.files.map((file) => Object.keys(file).sort())).toEqual([
      ["hash", "path", "size", "upload_id"], ["hash", "path", "size", "upload_id"],
    ]);
    expect(record.files.map((file) => file.path)).toEqual(["Media/Article (image 1).jpg", "Media/Article (image 2).jpg"]);
    expect(store.kept()).toHaveLength(2);
  });

  it("gives a break after any file the outcome unknown: no note, no new copy, the material kept", async () => {
    for (const breakAt of [1, 2]) {
      folder = new FakeDirectory("Mine");
      store = new MemoryStore();
      const clip = await prepared();
      let effects = 0;
      const broken = await vault.saveStandaloneBlock(clip, { ...options(), afterEffect: (effect) => {
        if (effect === "media" && ++effects === breakAt) throw new Error("worker stopped");
      } });
      expect(broken).toMatchObject({ ok: false, outcome: "unknown" });
      expect(folder.directories.get("Cards")?.files.size ?? 0).toBe(0);
      expect(folder.names()).toHaveLength(breakAt);
      if (breakAt === 1) {
        // The next file is not there: the save is not repeated over it.
        expect(await vault.lookupOperation("clip-1", "test-vault", options())).toMatchObject({ outcome: "unknown" });
        expect(await vault.saveStandaloneBlock({ ...clip, operation_mode: "resume" }, options())).toMatchObject({ outcome: "unknown" });
        expect(folder.names()).toHaveLength(1);
      }
      expect(folder.directories.get("Cards")?.files.size ?? 0).toBe(0);
      expect(store.kept()).toHaveLength(2);
    }
  });

  it("gives a refused write among the files the outcome unknown", async () => {
    const clip = await prepared();
    const media = await folder.getDirectoryHandle("Media", { create: true });
    await folder.getDirectoryHandle("Cards", { create: true });
    await folder.getDirectoryHandle("Collections", { create: true });
    const mine = await folder.getDirectoryHandle(".mine", { create: true });
    mine.files.set("layout.json", new FakeFile(".mine/layout.json", JSON.stringify({ cards: "Cards", media: "Media", collections: "Collections" })));
    const create = media.getFileHandle.bind(media);
    let creations = 0;
    media.getFileHandle = async (name: string, how?: { create?: boolean }) => {
      if (how?.create && ++creations === 2) throw new DOMException("the disk is full", "QuotaExceededError");
      return create(name, how);
    };
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: false, outcome: "unknown" });
    expect(folder.directories.get("Cards")!.files.size).toBe(0);
    expect(store.kept()).toHaveLength(2);
  });

  it("finishes a note whose files are all there after a break", async () => {
    const clip = await prepared();
    await vault.saveStandaloneBlock(clip, { ...options(), afterEffect: (effect) => { if (effect === "markdown") throw new Error("worker stopped"); } });
    expect(await vault.lookupOperation("clip-1", "test-vault", options())).toMatchObject({ ok: true, outcome: "committed" });
    expect(store.kept()).toEqual([]);
  });

  it("checks each file once after it is written and all files once before the note", async () => {
    const urls = Array.from({ length: 20 }, (_, index) => `https://cdn.example.net/${index}.jpg`);
    const site: Site = Object.fromEntries(urls.map((url) => [url, () => answer(JPEG(url))]));
    const { fetchFile } = network(site);
    const clip = await collected({ body: urls.map((url) => `![p](${url})`).join("\n\n") }, fetchFile);
    expect(await vault.saveStandaloneBlock(clip, options())).toMatchObject({ ok: true, remote_media: [] });
    const reads = [...folder.directories.get("Media")!.files.values()].map((file) => file.reads);
    expect(reads).toHaveLength(20);
    expect(Math.max(...reads)).toBe(2);
  });

  it("refuses by any target whose name another file of the folder took after the plan", async () => {
    const clip = await prepared();
    await vault.saveStandaloneBlock(clip, { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    const archive = await folder.getDirectoryHandle("Archive", { create: true });
    archive.files.set("Article (image 2).jpg", new FakeFile("Archive/Article (image 2).jpg", "foreign"));
    expect(await vault.saveStandaloneBlock({ ...clip, operation_mode: "resume" }, options()))
      .toMatchObject({ code: "name_conflict", terminal_rejected: true });
    expect(folder.names()).toEqual([]);
    expect(store.kept()).toEqual([]);
  });

  it("hashes a file part by part, never the whole at once", async () => {
    const size = 9 * 1024 * 1024;
    const bytes = new Uint8Array(size).fill(7);
    const { fetchFile } = network({ [SECOND]: () => answer(bytes) });
    const digest = vi.spyOn(webcrypto.subtle, "digest");
    const clip = await collected({ body: `![b](${SECOND})` }, fetchFile);
    const sizes = digest.mock.calls.map(([, data]) => (data as ArrayBuffer).byteLength);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4 * 1024 * 1024);
    digest.mockRestore();
    await vault.saveStandaloneBlock(clip, { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    const record = await store.get("operations", "clip-1") as { files: { hash: string; size: number }[] };
    const part = (from: number, to: number) => createHash("sha256").update(bytes.subarray(from, to)).digest();
    const parts = Buffer.concat([part(0, 4 * 1024 * 1024), part(4 * 1024 * 1024, 8 * 1024 * 1024), part(8 * 1024 * 1024, size)]);
    expect(record.files[0]).toMatchObject({ size, hash: createHash("sha256").update(parts).digest("hex") });
    expect(await vault.saveStandaloneBlock({ ...clip, operation_mode: "resume" }, options())).toMatchObject({ ok: true });
  });

  it("does not take a file of the right size with other bytes", async () => {
    const clip = await prepared();
    await vault.saveStandaloneBlock(clip, { ...options(), afterEffect: (effect) => { if (effect === "markdown") throw new Error("worker stopped"); } });
    const media = folder.directories.get("Media")!;
    const replaced = await media.getFileHandle("Article (image 1).jpg");
    replaced.blob = new NodeBlob([JPEG("owt")]);
    expect((await vault.lookupOperation("clip-1", "test-vault", options())).outcome).toBe("unknown");
  });

  it("reads an old entry with one medium and its bytes to the end", async () => {
    const bytes = new NodeBlob([JPEG("old")]);
    const hash = createHash("sha256").update(JPEG("old")).digest("hex");
    const markdown = "---\nsaved_at: 2026-08-31T12:00:00Z\n---\n# Old";
    await folder.getDirectoryHandle("Cards", { create: true });
    await folder.getDirectoryHandle("Media", { create: true });
    await folder.getDirectoryHandle("Collections", { create: true });
    const mine = await folder.getDirectoryHandle(".mine", { create: true });
    mine.files.set("layout.json", new FakeFile(".mine/layout.json", JSON.stringify({ cards: "Cards", media: "Media", collections: "Collections" })));
    const fingerprint = await call({ op: "fingerprint", value: JSON.stringify({ kind: "capture", request: { block_type: "image", title: "Old" } }) });
    await store.put("operations", "old-1", {
      id: "old-1", binding: "test-vault", fingerprint, kind: "capture", phase: "prepared",
      layout: { cards: "Cards", media: "Media", collections: "Collections" }, newSpace: false,
      slug: "Cards/Old", block_type: "image", markdown,
      hash: createHash("sha256").update(markdown).digest("hex"),
      media: { blob: bytes, extension: "jpg", hash, path: "Media/Old.jpg" },
    });
    expect(await vault.lookupOperation("old-1", "test-vault", options())).toMatchObject({ resumable: true });
    expect(await vault.saveStandaloneBlock({ operation_id: "old-1", block_type: "image", title: "Old", operation_mode: "resume" }, options()))
      .toMatchObject({ ok: true, slug: "Cards/Old" });
    expect(await folder.text("Media/Old.jpg")).toBe(await bytes.text());
    expect(await folder.text("Cards/Old.md")).toBe(markdown);
    expect(await store.get("operations", "old-1")).not.toHaveProperty("media");
  });

  it("reads an old entry whose medium is already written", async () => {
    const hash = createHash("sha256").update(JPEG("old")).digest("hex");
    const markdown = "---\nsaved_at: 2026-08-31T12:00:00Z\n---\n# Old";
    const media = await folder.getDirectoryHandle("Media", { create: true });
    await folder.getDirectoryHandle("Cards", { create: true });
    const mine = await folder.getDirectoryHandle(".mine", { create: true });
    mine.files.set("layout.json", new FakeFile(".mine/layout.json", JSON.stringify({ cards: "Cards", media: "Media", collections: "Collections" })));
    media.files.set("Old.jpg", new FakeFile("Media/Old.jpg", new NodeBlob([JPEG("old")])));
    await store.put("operations", "old-2", {
      id: "old-2", binding: "test-vault", fingerprint: "f", kind: "capture", phase: "media_published",
      layout: { cards: "Cards", media: "Media", collections: "Collections" }, newSpace: false,
      slug: "Cards/Old", block_type: "image", markdown,
      hash: createHash("sha256").update(markdown).digest("hex"),
      media: { blob: new NodeBlob([JPEG("old")]), extension: "jpg", hash, path: "Media/Old.jpg" },
    });
    expect(await vault.lookupOperation("old-2", "test-vault", options())).toMatchObject({ resumable: true });
  });
});

describe("the files of page_files", () => {
  async function collectedOne() {
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("two")) });
    return collected({ body: `![b](${SECOND})` }, fetchFile);
  }

  it("go after the receipt", async () => {
    const clip = await collectedOne();
    expect(store.kept()).toHaveLength(1);
    await vault.saveStandaloneBlock(clip, options());
    expect(store.kept()).toEqual([]);
  });

  it("go with a poster that was not needed", async () => {
    const { fetchFile } = network({ [VIDEO]: () => answer("", "text/plain", 404), [POSTER]: () => answer(JPEG("poster")), [SECOND]: () => answer(JPEG("thumb")) });
    const clip = await collected({ block_type: "video", image_url: SECOND, body: `![v](${VIDEO})`, video_posters: [{ video_url: VIDEO, poster_url: POSTER }] }, fetchFile);
    expect(store.kept()).toHaveLength(2);
    await vault.saveStandaloneBlock(clip, options());
    expect(folder.names()).toEqual(["Article.jpg"]);
    expect(store.kept()).toEqual([]);
  });

  it("go at terminal_rejected, before any effect", async () => {
    const clip = await collectedOne();
    expect(await vault.saveStandaloneBlock({ ...clip, tags: ["No such collection"] }, options()))
      .toMatchObject({ terminal_rejected: true, code: "collection_not_found" });
    expect(store.kept()).toEqual([]);
  });

  it("stay with an outcome that is unknown", async () => {
    const clip = await collectedOne();
    await vault.saveStandaloneBlock(clip, { ...options(), afterEffect: () => { throw new Error("worker stopped"); } });
    expect(store.kept()).toHaveLength(1);
  });

  it("go when the clipper leaves before its Save", async () => {
    const { fetchFile } = network({ [SECOND]: () => answer(JPEG("two")) });
    const { work, stored } = collection(fetchFile);
    await vault.collectPageFiles({ document_url: PAGE, body: `![b](${SECOND})`, image_url: null, video_posters: null }, work, options());
    expect(stored).toHaveLength(1);
    await vault.discardPageFiles(stored, options());
    expect(store.kept()).toEqual([]);
  });

  it("stop being collected once the clipper is gone", async () => {
    const controller = new AbortController();
    const { asked, fetchFile } = network({ [SECOND]: () => { controller.abort(); throw new TypeError("aborted"); } });
    const { work, stored } = collection(fetchFile, {}, controller.signal);
    await vault.collectPageFiles({ document_url: PAGE, body: `![b](${SECOND})`, image_url: null, video_posters: null }, work, options());
    expect(count(asked, SECOND)).toBe(1);
    expect(stored).toEqual([]);
  });

  it("are swept after a day unless a journal entry or a fixed operation names them", async () => {
    const dayAndMore = 25 * 60 * 60 * 1000;
    const old = Date.now() - dayAndMore;
    const blob = new NodeBlob(["bytes"]);
    await store.put("page_files", "orphan", { id: "orphan", blob, stored_at: old });
    await store.put("page_files", "young", { id: "young", blob, stored_at: Date.now() });
    await store.put("page_files", "journal", { id: "journal", blob, stored_at: old });
    await store.put("page_files", "pinned", { id: "pinned", blob, stored_at: old });
    await store.put("operations", "open", { id: "open", phase: "media_publishing", uploads: ["journal"] });
    await store.put("operations", "done", { id: "done", phase: "committed", slug: "Cards/A" });
    await vault.sweepPageFiles(async () => ["pinned"], options());
    expect(store.kept().sort()).toEqual(["page_files:journal", "page_files:pinned", "page_files:young"]);
  });

  it("are not looked for in the clipper's records when nothing is old", async () => {
    await store.put("page_files", "young", { id: "young", blob: new NodeBlob(["bytes"]), stored_at: Date.now() });
    const names = vi.fn(async () => []);
    await vault.sweepPageFiles(names, options());
    expect(names).not.toHaveBeenCalled();
  });

  it("refuse a prepared save whose bytes are gone before any effect", async () => {
    const clip = await collectedOne();
    await vault.saveStandaloneBlock(clip, { ...options(), afterPrepared: () => { throw new Error("worker stopped"); } });
    for (const key of store.kept()) store.values.delete(key);
    expect(await vault.saveStandaloneBlock({ ...clip, operation_mode: "resume" }, options()))
      .toMatchObject({ outcome: "not_committed", terminal_rejected: true });
    expect(folder.names()).toEqual([]);
  });
});
