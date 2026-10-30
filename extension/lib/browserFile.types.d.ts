/** Why the browser's bytes of a picture were not taken; the helper downloads it then. */
export type BrowserFileRefusal = { ok: false; reason: string };

declare global {
  var MineBrowserFile: {
    /** Limit of this path, the helper's own download limit (500 MiB). */
    readonly MAX_BYTES: number;
    /** Bytes of the file per message to the background. */
    readonly CHUNK_BYTES: number;
    /** Name of the port a transfer runs on, before its id. */
    readonly PORT_PREFIX: string;
    /**
     * How the page shows `url`: the tab's document is the picture, a picture
     * on the page was loaded from it, or neither.
     */
    shownAs(url: string, doc: Pick<Document, "URL" | "contentType" | "images">): "document" | "page" | null;
    /** The bytes of `url` from the browser's cache, never from a new request to the site. */
    read(
      url: string,
      doc: Pick<Document, "URL" | "contentType" | "images">,
      fetchFile: typeof fetch,
    ): Promise<{ ok: true; blob: Blob } | BrowserFileRefusal>;
    /** The name an upload of `url` carries, by the answered type, else the address. */
    uploadName(url: string, contentType: string): string;
    /** Page half of the transfer: read `url` and hand it to the background on the port of `transferId`. */
    send(url: string, transferId: string): Promise<{ ok: true; size: number } | BrowserFileRefusal>;
  };
}

export {};
