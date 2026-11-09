// Declarations for lib/pageFiles.js (SPEC_CLIPPER.md, «Один путь файла со
// страницы», Б7, Б9). The plan's types are generated from the core.
import type { BrowserFileFailure, PageFileAnswer, BrowserFileSource } from "./browserFile.types";
import type { PageFile, PageFilePlan } from "../../src/types/generated";

export type { PageFile, PageFilePlan };

/** What the browser did about one file: the element of `browser_files` of a Save. */
export interface BrowserFileEntry {
  url: string;
  upload_id?: string;
  source?: BrowserFileSource;
  final_url?: string;
  status?: number;
  retry_after?: number;
  failure?: BrowserFileFailure;
}

export interface RequestLimiter {
  /** A place in the limits, given back by calling the result. Rejects when `signal` aborts. */
  acquire(host: string, parallel: number, perHost: number, signal: AbortSignal): Promise<() => void>;
}

/** An answer with the file. */
export interface FileAnswer {
  kind: "file";
  blob: Blob;
  source: BrowserFileSource;
  finalUrl: string;
}

/** The parts of a collection its executor provides. */
export interface PageFileWork {
  signal: AbortSignal;
  limiter: RequestLimiter;
  /** The page's half: its cache, or its own request (Б5). */
  pageRead(url: string, mode: "cache" | "request"): Promise<PageFileAnswer | FileAnswer>;
  /** The request from outside the page (Б6). */
  request(file: PageFile): Promise<PageFileAnswer | FileAnswer>;
  /**
   * Keep the bytes; the id they are known by, or null when they were not kept.
   * A rejection says the storage refused them: the entry's failure is `not_stored`.
   */
  store(blob: Blob, url: string): Promise<string | null>;
  /**
   * The pauses before each further request of a file after a failure that may
   * pass (Б13). Absent, as with the helper, which takes over from one request.
   */
  retryPausesMs?: readonly number[];
}

/** What a request from outside the page needs of its executor. */
export interface FileRequester {
  signal: AbortSignal;
  idleMs?: number;
  fetchFile: typeof fetch;
  /** The rule that gives the request its `Referer`, or null without one. */
  addRefererRule(address: string, referer: string | null): Promise<number | null>;
  removeRefererRule(rule: number | null): Promise<void>;
}

declare global {
  var MinePageFiles: {
    PORT_PREFIX: string;
    SAVE_PORT_PREFIX: string;
    IDLE_MS: number;
    hostOf(url: string): string;
    withoutFragment(url: string): string;
    createLimiter(): RequestLimiter;
    requestFile(file: PageFile, requester: FileRequester): Promise<PageFileAnswer | FileAnswer>;
    collect(plan: PageFilePlan, work: PageFileWork): Promise<BrowserFileEntry[]>;
  };
}
