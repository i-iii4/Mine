// The page's half of the file route (SPEC_CLIPPER.md, «Один путь файла со
// страницы», Б5). The background puts this script into the top frame of the page
// on Save and imports it for its own half of the transfer. The script works only
// with a file of the page's own origin: it asks the browser's cache, which never
// reaches the network, and then makes the page's own request, for which the
// browser sets `Referer` and the cookies. The answer goes to the background on a
// port, part by part; a page never speaks to the helper's upload server.
(function (root) {
  "use strict";

  /**
   * Limit of this path: the helper's own download limit (`MAX_MEDIA_BYTES`,
   * src-tauri/src/net.rs), so how a file is obtained never changes which
   * files are saved.
   */
  const MAX_BYTES = 500 * 1024 * 1024;
  /** Bytes of the file per message to the background. */
  const CHUNK_BYTES = 4 * 1024 * 1024;
  /** Name of the port a transfer runs on, before its id. */
  const PORT_PREFIX = "mine-browser-file:";
  /** Only a complete answer is the file; a part (206) is not. */
  const WHOLE_FILE_STATUS = 200;
  const WEB_ADDRESS = /^https?:\/\//i;
  /**
   * How long bytes may wait for a full part. The background counts 15 seconds
   * of silence as a stalled file (Б11), and a slow site fills 4 MiB for longer.
   */
  const LONGEST_HELD_MS = 5_000;
  /** Extension of the upload name by the type the browser answered with. */
  /** @type {Record<string, string>} */
  const EXTENSION_BY_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  /** The extension the helper assumes when nothing names one; it checks the bytes. */
  const FALLBACK_EXTENSION = "jpg";
  const URL_EXTENSION = /\.([a-z0-9]{2,5})$/i;

  /**
   * Seconds of a `Retry-After` value (RFC 9110, 10.2.3): a number or an HTTP
   * date; a date already past means now, anything else says nothing.
   * @param {string | null} value
   * @param {number} now milliseconds since the epoch
   * @returns {number | null}
   */
  function retryAfterSeconds(value, now) {
    const text = value?.trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
  }

  /**
   * Whether an answer declares a web page: an error page or a bot check does
   * not become a picture (Б8).
   * @param {Pick<Response, "headers">} response
   */
  function declaresWebPage(response) {
    return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() === "text/html";
  }

  /**
   * What the browser answers for `url` of the page at `pageUrl`. `cache` asks
   * only the cache: `only-if-cached` answers from it or not at all, and Fetch
   * allows it only for an address of the page's own origin. `request` makes the
   * page's own request. A page request the browser refuses, as a redirect to
   * another domain, is `refused`: the background may ask from outside.
   * @param {string} url
   * @param {"cache" | "request"} mode
   * @param {string} pageUrl
   * @param {typeof fetch} fetchFile
   * @param {AbortSignal} [signal]
   * @returns {Promise<import("./browserFile.types").PageFileAnswer | { kind: "open", response: Response }>}
   */
  async function open(url, mode, pageUrl, fetchFile, signal) {
    if (!WEB_ADDRESS.test(url) || !URL.canParse(url) || new URL(url).origin !== new URL(pageUrl).origin) {
      return { kind: "elsewhere" };
    }
    /** @type {RequestInit} */
    const options = { mode: "same-origin", credentials: "same-origin", ...(signal ? { signal } : {}) };
    if (mode === "cache") options.cache = "only-if-cached";
    /** @type {Response} */
    let response;
    try {
      response = await fetchFile(url, options);
    } catch {
      return mode === "cache" ? { kind: "miss" } : { kind: "refused" };
    }
    if (response.status !== WHOLE_FILE_STATUS) {
      await response.body?.cancel();
      if (mode === "cache") return { kind: "miss" };
      return { kind: "status", status: response.status,
        retryAfter: retryAfterSeconds(response.headers.get("retry-after"), Date.now()) };
    }
    if (declaresWebPage(response)) {
      await response.body?.cancel();
      return { kind: "failure", failure: "not_a_file" };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body?.cancel();
      return { kind: "failure", failure: "too_large" };
    }
    return { kind: "open", response };
  }

  /**
   * The file name the upload carries: only its extension matters, the helper
   * names the media after the card and checks the bytes.
   * @param {string} url
   * @param {string} contentType
   */
  function uploadName(url, contentType) {
    const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    let fromAddress;
    try {
      fromAddress = new URL(url).pathname.match(URL_EXTENSION)?.[1]?.toLowerCase();
    } catch {
      fromAddress = undefined;
    }
    return `picture.${EXTENSION_BY_TYPE[type] ?? fromAddress ?? FALLBACK_EXTENSION}`;
  }

  /**
   * The base64 text of `blob`.
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  function base64Of(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        resolve(text.slice(text.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Answer the background about `url` on the port of `transferId`: a `start`, the
   * parts of the file, one per `next` it asks for, so no more than one waits in
   * between, and an `end`; or one `answer` without a file. When the port closes,
   * the request stops.
   * @param {string} url
   * @param {string} transferId
   * @param {"cache" | "request"} mode
   * @param {{ pageUrl: string, fetchFile: typeof fetch, connect: typeof chrome.runtime.connect }} page
   * @returns {Promise<void>}
   */
  async function deliver(url, transferId, mode, page) {
    const port = page.connect({ name: `${PORT_PREFIX}${transferId}` });
    const controller = new AbortController();
    /** @type {Array<() => void>} */
    const waiting = [];
    let closed = false;
    port.onMessage.addListener((/** @type {{ kind?: unknown }} */ message) => {
      if (message?.kind === "next") waiting.shift()?.();
    });
    port.onDisconnect.addListener(() => {
      closed = true;
      controller.abort();
      for (const resume of waiting.splice(0)) resume();
    });
    /** @returns {Promise<void>} */
    const next = () => new Promise((resolve) => {
      if (closed) resolve();
      else waiting.push(resolve);
    });
    /** @param {unknown} message @returns {Promise<void>} */
    const sent = (message) => {
      const answered = next();
      if (!closed) port.postMessage(message);
      return answered;
    };
    /** @param {import("./browserFile.types").PageFileAnswer} answer */
    const answerWith = (answer) => {
      if (!closed) port.postMessage({ kind: "answer", answer });
    };
    const opened = await open(url, mode, page.pageUrl, page.fetchFile, controller.signal);
    if (opened.kind !== "open") {
      answerWith(opened);
      return;
    }
    const { response } = opened;
    const contentType = response.headers.get("content-type") ?? "";
    await sent({ kind: "start", contentType, source: mode === "cache" ? "cache" : "page", finalUrl: response.url });
    const reader = response.body?.getReader();
    if (!reader) {
      answerWith({ kind: "failure", failure: "not_a_file" });
      return;
    }
    /** @type {Uint8Array<ArrayBuffer>[]} */
    let held = [];
    let heldBytes = 0;
    let total = 0;
    let heldSince = Date.now();
    const flush = async () => {
      if (heldBytes === 0) return;
      const data = await base64Of(new Blob(held));
      held = [];
      heldBytes = 0;
      heldSince = Date.now();
      await sent({ kind: "part", data });
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) {
          await reader.cancel();
          answerWith({ kind: "failure", failure: "too_large" });
          return;
        }
        held.push(value);
        heldBytes += value.length;
        if (heldBytes >= CHUNK_BYTES || Date.now() - heldSince >= LONGEST_HELD_MS) await flush();
        if (closed) return;
      }
      await flush();
    } catch {
      answerWith({ kind: "failure", failure: "no_answer" });
      return;
    }
    if (!closed) port.postMessage({ kind: "end" });
  }

  /**
   * Page half: start answering about `url` and return at once, so the call the
   * background made is over while the file travels on its port (Б11).
   * @param {string} url
   * @param {string} transferId
   * @param {"cache" | "request"} mode
   * @returns {{ started: true }}
   */
  function send(url, transferId, mode) {
    void deliver(url, transferId, mode, {
      pageUrl: location.href,
      fetchFile: globalThis.fetch.bind(globalThis),
      connect: chrome.runtime.connect.bind(chrome.runtime),
    });
    return { started: true };
  }

  root.MineBrowserFile = { MAX_BYTES, CHUNK_BYTES, PORT_PREFIX, retryAfterSeconds, declaresWebPage, open, uploadName, deliver, send };
})(globalThis);
