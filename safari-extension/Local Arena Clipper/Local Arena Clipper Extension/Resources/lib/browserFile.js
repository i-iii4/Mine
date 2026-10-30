// The file of a picture as the browser already has it (SPEC_CLIPPER.md,
// «Файл картинки из браузера, отказ сайта и причина ошибки», Б1). The
// background puts this script into the top frame of the page on Save and
// imports it for its own half of the transfer. The page half reads only a
// file the page shows, only from the browser's cache: the site is never
// asked again. Whatever it cannot read the helper downloads, as before.
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
   * The address `value` loads, without its fragment; null when it is not an
   * address.
   * @param {string} value
   */
  function loadedAddress(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} a
   * @param {string} b
   */
  function sameAddress(a, b) {
    const left = loadedAddress(a);
    return left !== null && left === loadedAddress(b);
  }

  /**
   * How the page shows `url`: `document` when the tab's document is the
   * picture itself, `page` when a picture on the page was loaded from that
   * address, null when the page does not show that file (a reduced copy, a
   * feed, a gallery).
   * @param {string} url
   * @param {Pick<Document, "URL" | "contentType" | "images">} doc
   * @returns {"document" | "page" | null}
   */
  function shownAs(url, doc) {
    if (doc.contentType.startsWith("image/") && sameAddress(doc.URL, url)) return "document";
    for (const image of Array.from(doc.images)) {
      if (sameAddress(image.currentSrc || image.src, url)) return "page";
    }
    return null;
  }

  /**
   * The bytes of `url` the browser already loaded for this page, without a
   * new request to the site: `only-if-cached` answers from the cache or not
   * at all. Fetch allows it only for an address of the page's own origin;
   * a picture of another origin is the helper's to download.
   * @param {string} url
   * @param {Pick<Document, "URL" | "contentType" | "images">} doc
   * @param {typeof fetch} fetchFile
   * @returns {Promise<{ ok: true, blob: Blob } | { ok: false, reason: string }>}
   */
  async function read(url, doc, fetchFile) {
    if (!WEB_ADDRESS.test(url)) return { ok: false, reason: "not_web_address" };
    if (shownAs(url, doc) === null) return { ok: false, reason: "not_shown" };
    if (new URL(url).origin !== new URL(doc.URL).origin) return { ok: false, reason: "other_origin" };
    /** @type {Response} */
    let response;
    try {
      response = await fetchFile(url, { cache: "only-if-cached", mode: "same-origin", credentials: "same-origin" });
    } catch {
      return { ok: false, reason: "not_cached" };
    }
    if (response.status !== WHOLE_FILE_STATUS) {
      await response.body?.cancel();
      return { ok: false, reason: "not_cached" };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body?.cancel();
      return { ok: false, reason: "too_large" };
    }
    const blob = await response.blob();
    if (blob.size > MAX_BYTES) return { ok: false, reason: "too_large" };
    if (blob.size === 0) return { ok: false, reason: "empty" };
    return { ok: true, blob };
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
   * Page half: read `url` and hand it to the background on the port of
   * `transferId`, one part per `next` it asks for, so no more than one part
   * waits in between.
   * @param {string} url
   * @param {string} transferId
   * @returns {Promise<{ ok: true, size: number } | { ok: false, reason: string }>}
   */
  async function send(url, transferId) {
    const file = await read(url, document, globalThis.fetch.bind(globalThis));
    if (!file.ok) return file;
    const { blob } = file;
    const port = chrome.runtime.connect({ name: `${PORT_PREFIX}${transferId}` });
    /** @type {Array<() => void>} */
    const waiting = [];
    let closed = false;
    port.onMessage.addListener((message) => {
      if (message?.kind === "next") waiting.shift()?.();
    });
    port.onDisconnect.addListener(() => {
      closed = true;
      for (const resume of waiting.splice(0)) resume();
    });
    const next = () => new Promise((resolve) => {
      if (closed) resolve(undefined);
      else waiting.push(() => resolve(undefined));
    });
    const asked = next();
    port.postMessage({ kind: "start", contentType: blob.type, size: blob.size });
    await asked;
    for (let offset = 0; offset < blob.size && !closed; offset += CHUNK_BYTES) {
      const data = await base64Of(blob.slice(offset, offset + CHUNK_BYTES));
      const answered = next();
      port.postMessage({ kind: "part", data });
      await answered;
    }
    if (closed) return { ok: false, reason: "transfer_closed" };
    port.postMessage({ kind: "end" });
    return { ok: true, size: blob.size };
  }

  root.MineBrowserFile = { MAX_BYTES, CHUNK_BYTES, PORT_PREFIX, shownAs, read, uploadName, send };
})(globalThis);
