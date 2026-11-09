// Declarations for lib/browserFile.js (SPEC_CLIPPER.md, «Один путь файла со
// страницы», Б5).

/** Why the browser has no file for an address (Б9). */
export type BrowserFileFailure = "no_answer" | "not_a_file" | "too_large" | "host_limited" | "not_stored";

/** Where a file of the browser came from (Б4). */
export type BrowserFileSource = "cache" | "page" | "browser";

/** An answer of the page about a file, without the file. */
export type PageFileAnswer =
  /** The file is not of the page's origin, or the page cannot be asked. */
  | { kind: "elsewhere" }
  /** The cache does not hold it. */
  | { kind: "miss" }
  /** The browser refused the page's request. */
  | { kind: "refused" }
  /** The page fell silent. */
  | { kind: "stalled" }
  | { kind: "status"; status: number; retryAfter: number | null }
  | { kind: "failure"; failure: BrowserFileFailure };

declare global {
  var MineBrowserFile: {
    MAX_BYTES: number;
    CHUNK_BYTES: number;
    PORT_PREFIX: string;
    retryAfterSeconds(value: string | null, now: number): number | null;
    declaresWebPage(response: Pick<Response, "headers">): boolean;
    open(
      url: string,
      mode: "cache" | "request",
      pageUrl: string,
      fetchFile: typeof fetch,
      signal?: AbortSignal,
    ): Promise<PageFileAnswer | { kind: "open"; response: Response }>;
    uploadName(url: string, contentType: string): string;
    deliver(
      url: string,
      transferId: string,
      mode: "cache" | "request",
      page: { pageUrl: string; fetchFile: typeof fetch; connect: typeof chrome.runtime.connect },
    ): Promise<void>;
    send(url: string, transferId: string, mode: "cache" | "request"): { started: true };
  };
}
