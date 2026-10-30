import { afterEach, describe, expect, it, vi } from "vitest";

import "./browserFile.js";

const { MAX_BYTES, CHUNK_BYTES, PORT_PREFIX, shownAs, read, uploadName, send } = globalThis.MineBrowserFile;

// SPEC_CLIPPER.md, «Файл картинки из браузера, отказ сайта и причина ошибки»,
// Б1: the bytes come from the browser only when it shows the very file, and
// only from its cache; everything else is the helper's download.

const PICTURE = "https://upload.example.org/a/a1/Harvest.jpg";

type Shown = Pick<Document, "URL" | "contentType" | "images">;

/** A document at `url` of type `contentType` with pictures loaded from `sources`. */
function pageAt(url: string, contentType: string, sources: string[] = []): Shown {
  const images = sources.map((source) => ({ currentSrc: source, src: source }));
  return { URL: url, contentType, images: images as unknown as HTMLCollectionOf<HTMLImageElement> };
}

/** A fetch that answers from the cache with `body`, recording what it was asked. */
function cachedFetch(body: Uint8Array<ArrayBuffer>, init: { status?: number; type?: string; length?: string } = {}) {
  const asked: Array<{ url: string; options: RequestInit | undefined }> = [];
  const type = init.type ?? "image/jpeg";
  const fetchFile = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    asked.push({ url: String(url), options });
    const headers = new Headers({ "content-type": type });
    if (init.length !== undefined) headers.set("content-length", init.length);
    // The page's own Blob, as the browser gives it: the page reads it with
    // its FileReader.
    return { status: init.status ?? 200, headers, body: null, blob: async () => new Blob([body], { type }) };
  });
  return { fetchFile: fetchFile as unknown as typeof fetch, asked };
}

describe("shownAs", () => {
  it("knows the tab's document is the picture itself", () => {
    expect(shownAs(PICTURE, pageAt(PICTURE, "image/jpeg"))).toBe("document");
    expect(shownAs(PICTURE, pageAt(`${PICTURE}#zoom`, "image/jpeg"))).toBe("document");
  });

  it("knows a picture of the page was loaded from the same address", () => {
    const page = pageAt("https://upload.example.org/wiki/Harvest", "text/html", ["https://upload.example.org/x.png", PICTURE]);
    expect(shownAs(PICTURE, page)).toBe("page");
  });

  it("does not take a reduced copy, a feed or a gallery for the file", () => {
    const page = pageAt("https://upload.example.org/wiki/Harvest", "text/html", [
      "https://upload.example.org/a/a1/thumb/Harvest.jpg/320px-Harvest.jpg",
    ]);
    expect(shownAs(PICTURE, page)).toBeNull();
    expect(shownAs(PICTURE, pageAt("https://upload.example.org/other.jpg", "image/jpeg"))).toBeNull();
  });
});

describe("read", () => {
  it("takes the cached bytes of the picture the tab shows, asking the cache only", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const { fetchFile, asked } = cachedFetch(bytes);

    const file = await read(PICTURE, pageAt(PICTURE, "image/jpeg"), fetchFile);

    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(bytes);
    expect(asked).toEqual([{ url: PICTURE, options: { cache: "only-if-cached", mode: "same-origin", credentials: "same-origin" } }]);
  });

  it("asks nothing for a picture the page does not show", async () => {
    const { fetchFile, asked } = cachedFetch(new Uint8Array([1]));
    const file = await read(PICTURE, pageAt("https://upload.example.org/wiki/Harvest", "text/html"), fetchFile);
    expect(file).toEqual({ ok: false, reason: "not_shown" });
    expect(asked).toEqual([]);
  });

  // Fetch allows `only-if-cached` for the page's own origin alone: a picture
  // of another origin is never asked of the site from the page.
  it("asks nothing for a picture of another origin", async () => {
    const { fetchFile, asked } = cachedFetch(new Uint8Array([1]));
    const page = pageAt("https://shop.example/products/shirt", "text/html", ["https://cdn.example/shirt.jpg"]);
    const file = await read("https://cdn.example/shirt.jpg", page, fetchFile);
    expect(file).toEqual({ ok: false, reason: "other_origin" });
    expect(asked).toEqual([]);
  });

  it("gives up when the cache has no whole file", async () => {
    const missing = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await read(PICTURE, pageAt(PICTURE, "image/jpeg"), missing)).toEqual({ ok: false, reason: "not_cached" });
    const { fetchFile } = cachedFetch(new Uint8Array([1, 2]), { status: 206 });
    expect(await read(PICTURE, pageAt(PICTURE, "image/jpeg"), fetchFile)).toEqual({ ok: false, reason: "not_cached" });
    expect(await read("data:image/png;base64,xx", pageAt(PICTURE, "image/jpeg"), fetchFile))
      .toEqual({ ok: false, reason: "not_web_address" });
  });

  // The limit of this path is the helper's download limit, 500 MiB.
  it("leaves a file over 500 MiB to the helper", async () => {
    expect(MAX_BYTES).toBe(500 * 1024 * 1024);
    const { fetchFile } = cachedFetch(new Uint8Array([1]), { length: String(MAX_BYTES + 1) });
    expect(await read(PICTURE, pageAt(PICTURE, "image/jpeg"), fetchFile)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("uploadName", () => {
  it("names the upload by the answered type, else by the address", () => {
    expect(uploadName(PICTURE, "image/png")).toBe("picture.png");
    expect(uploadName(PICTURE, "image/jpeg; charset=binary")).toBe("picture.jpg");
    expect(uploadName("https://example.org/a/b.WEBP?x=1", "")).toBe("picture.webp");
    expect(uploadName("https://example.org/image?id=4", "")).toBe("picture.jpg");
  });
});

describe("send", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A background that asks for every next part and keeps what came. */
  function backgroundPort() {
    const messages: Array<Record<string, unknown>> = [];
    const listeners: Array<(message: unknown) => void> = [];
    const port = {
      name: "",
      postMessage: (message: Record<string, unknown>) => {
        messages.push(message);
        if (message.kind !== "end") queueMicrotask(() => listeners.forEach((listener) => listener({ kind: "next" })));
      },
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
      onDisconnect: { addListener: () => undefined },
    };
    const connect = vi.fn((info: { name: string }) => {
      port.name = info.name;
      return port;
    });
    return { port, connect, messages };
  }

  it("hands the file over part by part on its own port", async () => {
    const bytes = new Uint8Array(CHUNK_BYTES + 5).map((_, index) => index % 251);
    const { fetchFile } = cachedFetch(bytes);
    const { port, connect, messages } = backgroundPort();
    vi.stubGlobal("fetch", fetchFile);
    vi.stubGlobal("chrome", { runtime: { connect } });
    Object.defineProperty(document, "contentType", { configurable: true, value: "image/jpeg" });
    const url = `${window.location.origin}/Harvest.jpg`;
    window.history.replaceState(null, "", "/Harvest.jpg");

    const sent = await send(url, "transfer-1");

    expect(sent).toEqual({ ok: true, size: bytes.length });
    expect(port.name).toBe(`${PORT_PREFIX}transfer-1`);
    expect(messages.map((message) => message.kind)).toEqual(["start", "part", "part", "end"]);
    expect(messages[0]).toEqual({ kind: "start", contentType: "image/jpeg", size: bytes.length });
    const decoded = Buffer.concat(messages
      .filter((message) => message.kind === "part")
      .map((message) => Buffer.from(String(message.data), "base64")));
    // Byte for byte, compared at once: a deep equality of 4 MiB is too slow.
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
  });
});
