import { describe, expect, it, vi } from "vitest";

import "./browserFile.js";

const { MAX_BYTES, CHUNK_BYTES, PORT_PREFIX, retryAfterSeconds, open, uploadName, deliver } = globalThis.MineBrowserFile;

// SPEC_CLIPPER.md, «Один путь файла со страницы», Б5: the page's half works only
// with a file of its own origin: the cache first, which never reaches the
// network, then the page's own request.

const PAGE = "https://upload.example.org/wiki/Harvest";
const PICTURE = "https://upload.example.org/a/a1/Harvest.jpg";

/** The answer of a fetch: a body read in the given portions. */
function answer(portions: Uint8Array[], init: { status?: number; type?: string; length?: string; retryAfter?: string; url?: string } = {}) {
  const headers = new Headers({ "content-type": init.type ?? "image/jpeg" });
  if (init.length !== undefined) headers.set("content-length", init.length);
  if (init.retryAfter !== undefined) headers.set("retry-after", init.retryAfter);
  let next = 0;
  const cancel = vi.fn(async () => undefined);
  const body = {
    cancel,
    getReader: () => ({
      cancel,
      read: async () => (next < portions.length ? { done: false, value: portions[next++] } : { done: true, value: undefined }),
    }),
  };
  return { status: init.status ?? 200, headers, body, url: init.url ?? PICTURE } as unknown as Response;
}

function fetchAnswering(response: Response | Error) {
  const asked: Array<{ url: string; options: RequestInit | undefined }> = [];
  const fetchFile = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    asked.push({ url: String(url), options });
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetchFile: fetchFile as unknown as typeof fetch, asked };
}

describe("open", () => {
  it("asks the cache only, and the page's own request carries what the page's would", async () => {
    const cache = fetchAnswering(answer([new Uint8Array([1])]));
    expect((await open(PICTURE, "cache", PAGE, cache.fetchFile)).kind).toBe("open");
    expect(cache.asked[0]?.options).toMatchObject({ cache: "only-if-cached", mode: "same-origin", credentials: "same-origin" });

    const request = fetchAnswering(answer([new Uint8Array([1])]));
    expect((await open(PICTURE, "request", PAGE, request.fetchFile)).kind).toBe("open");
    expect(request.asked[0]?.options?.cache).toBeUndefined();
    expect(request.asked[0]?.options).toMatchObject({ mode: "same-origin", credentials: "same-origin" });
  });

  it("does not ask for a file of another origin, or for what is not a web address", async () => {
    const { fetchFile, asked } = fetchAnswering(answer([new Uint8Array([1])]));
    expect(await open("https://cdn.example.net/a.jpg", "cache", PAGE, fetchFile)).toEqual({ kind: "elsewhere" });
    expect(await open("data:image/png;base64,AA", "request", PAGE, fetchFile)).toEqual({ kind: "elsewhere" });
    expect(await open("https://", "request", PAGE, fetchFile)).toEqual({ kind: "elsewhere" });
    expect(asked).toEqual([]);
  });

  it("takes a refusal of the cache for a miss, and of the page's request for a refusal", async () => {
    const refused = fetchAnswering(new TypeError("Failed to fetch"));
    expect(await open(PICTURE, "cache", PAGE, refused.fetchFile)).toEqual({ kind: "miss" });
    expect(await open(PICTURE, "request", PAGE, refused.fetchFile)).toEqual({ kind: "refused" });
    const part = answer([], { status: 206 });
    expect(await open(PICTURE, "cache", PAGE, fetchAnswering(part).fetchFile)).toEqual({ kind: "miss" });
  });

  it("reports the status of the page's request with the wait the site names", async () => {
    const limited = answer([], { status: 429, retryAfter: "600" });
    expect(await open(PICTURE, "request", PAGE, fetchAnswering(limited).fetchFile))
      .toEqual({ kind: "status", status: 429, retryAfter: 600 });
    const gone = answer([], { status: 404 });
    expect(await open(PICTURE, "request", PAGE, fetchAnswering(gone).fetchFile))
      .toEqual({ kind: "status", status: 404, retryAfter: null });
  });

  it("does not take a web page for the file", async () => {
    const page = answer([], { type: "text/html; charset=utf-8" });
    expect(await open(PICTURE, "request", PAGE, fetchAnswering(page).fetchFile)).toEqual({ kind: "failure", failure: "not_a_file" });
    const cached = answer([], { type: "TEXT/HTML" });
    expect(await open(PICTURE, "cache", PAGE, fetchAnswering(cached).fetchFile)).toEqual({ kind: "failure", failure: "not_a_file" });
  });

  it("cancels a file that declares more than 500 MiB", async () => {
    const large = answer([], { length: String(MAX_BYTES + 1) });
    expect(await open(PICTURE, "request", PAGE, fetchAnswering(large).fetchFile)).toEqual({ kind: "failure", failure: "too_large" });
    expect(large.body?.cancel).toHaveBeenCalled();
  });
});

describe("retryAfterSeconds", () => {
  const now = Date.parse("Thu, 29 Oct 2026 12:00:00 GMT");

  it("reads seconds and dates, and says nothing about anything else", () => {
    expect(retryAfterSeconds("600", now)).toBe(600);
    expect(retryAfterSeconds(" 0 ", now)).toBe(0);
    expect(retryAfterSeconds("Thu, 29 Oct 2026 12:10:00 GMT", now)).toBe(600);
    expect(retryAfterSeconds("Thu, 29 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds("soon", now)).toBeNull();
    expect(retryAfterSeconds(null, now)).toBeNull();
  });
});

describe("uploadName", () => {
  it("names the upload by the answered type, else by the address", () => {
    expect(uploadName(PICTURE, "image/webp")).toBe("picture.webp");
    expect(uploadName(PICTURE, "image/jpeg; charset=binary")).toBe("picture.jpg");
    expect(uploadName("https://example.org/a.png?w=1", "")).toBe("picture.png");
    expect(uploadName("https://example.org/a", "")).toBe("picture.jpg");
  });
});

/** A port the background holds the other end of: it asks for the next part after each. */
function connected(onClose?: (close: () => void) => void) {
  const posted: Array<Record<string, unknown>> = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const closeListeners: Array<() => void> = [];
  const port = {
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => closeListeners.push(listener) },
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
      if (message.kind === "start" || message.kind === "part") {
        queueMicrotask(() => messageListeners.forEach((listener) => listener({ kind: "next" })));
      }
    },
    disconnect: () => undefined,
  };
  onClose?.(() => closeListeners.forEach((listener) => listener()));
  const connect = vi.fn(() => port) as unknown as typeof chrome.runtime.connect;
  return { connect, posted };
}

describe("deliver", () => {
  it("answers on its own port without a file", async () => {
    const { connect, posted } = connected();
    await deliver("https://cdn.example.net/a.jpg", "id-1", "cache", {
      pageUrl: PAGE, fetchFile: fetchAnswering(answer([])).fetchFile, connect,
    });
    expect(connect).toHaveBeenCalledWith({ name: `${PORT_PREFIX}id-1` });
    expect(posted).toEqual([{ kind: "answer", answer: { kind: "elsewhere" } }]);
  });

  it("hands the file over part by part, and names where it came from", async () => {
    const whole = new Uint8Array(CHUNK_BYTES + 3).fill(7);
    const { connect, posted } = connected();
    await deliver(PICTURE, "id-2", "request", {
      pageUrl: PAGE,
      fetchFile: fetchAnswering(answer([whole.subarray(0, CHUNK_BYTES), whole.subarray(CHUNK_BYTES)])).fetchFile,
      connect,
    });
    expect(posted.map((message) => message.kind)).toEqual(["start", "part", "part", "end"]);
    expect(posted[0]).toEqual({ kind: "start", contentType: "image/jpeg", source: "page", finalUrl: PICTURE });
  });

  it("names the cache as the source of a file from the cache", async () => {
    const { connect, posted } = connected();
    await deliver(PICTURE, "id-3", "cache", {
      pageUrl: PAGE, fetchFile: fetchAnswering(answer([new Uint8Array([1, 2])])).fetchFile, connect,
    });
    expect(posted[0]).toMatchObject({ kind: "start", source: "cache" });
    expect(posted.at(-1)).toEqual({ kind: "end" });
  });

  it("does not go past 500 MiB when the file declares no length", async () => {
    const piece = new Uint8Array(1);
    const large = answer([piece]);
    const reader = large.body!.getReader() as unknown as { read: () => Promise<unknown>; cancel: () => Promise<void> };
    (large.body as unknown as { getReader: () => unknown }).getReader = () => ({
      cancel: reader.cancel,
      // One portion that alone is past the limit stands for a long stream.
      read: async () => ({ done: false, value: { length: MAX_BYTES + 1 } as unknown as Uint8Array }),
    });
    const { connect, posted } = connected();
    await deliver(PICTURE, "id-4", "request", { pageUrl: PAGE, fetchFile: fetchAnswering(large).fetchFile, connect });
    expect(posted.at(-1)).toEqual({ kind: "answer", answer: { kind: "failure", failure: "too_large" } });
  });

  it("stops the request when the background closes the port", async () => {
    let close = () => undefined as void;
    const { connect } = connected((closing) => { close = closing; });
    let signal: AbortSignal | undefined;
    const fetchFile = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      signal = options?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const delivered = deliver(PICTURE, "id-5", "request", { pageUrl: PAGE, fetchFile, connect });
    await Promise.resolve();
    close();
    await delivered;
    expect(signal?.aborted).toBe(true);
  });
});
