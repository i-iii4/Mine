import type { PageFilesRequest, SaveOutcome, SavePhase, VaultWriteLayoutDto } from "../../src/types/generated";
import type { CollectionCount } from "./mineCore.types";
import type { BrowserFileEntry, PageFileWork } from "./pageFiles.types";
import type { SaveProtocolRejection } from "./saveProtocol.types";

/** What the browser executor can do; the clipper reads it from the status. */
export type StandaloneCapabilities = Readonly<{
  save_operation_v1: boolean;
  operation_lookup_v1: boolean;
  atomic_no_clobber: boolean;
  durable_flush: boolean;
  serialized_extension_writes: boolean;
}>;

/** The folder the browser executor writes into, as `getStandaloneStatus` reports it. */
export type StandaloneStatusReply = {
  configured: boolean;
  bindingId?: string;
  folderName?: string;
  permission?: PermissionState;
  capabilities: StandaloneCapabilities;
  error?: string;
};

/**
 * A save request as the clipper sends it (the payload of `standaloneSave`).
 * The save core validates every field; keys not named here are part of the
 * request's fingerprint.
 */
export interface StandaloneSaveRequest {
  operation_id?: string;
  /** `start` (the default) or `resume`; any other value is refused. */
  operation_mode?: string;
  /** The older name of `operation_mode`, read for `resume` only. */
  mode?: string;
  binding_id?: string;
  executor_id?: string;
  vault_path?: string | null;
  block_type?: string;
  title?: string | null;
  url?: string | null;
  body?: string;
  tags?: string[];
  saved_at?: string;
  author?: string | null;
  description?: string | null;
  width?: number | null;
  height?: number | null;
  selection?: boolean;
  /** The bytes of a screenshot: they are at hand, and take no route. */
  screenshot_data_url?: string;
  /** The file of the card, a preview or a picture: its address names an entry of `browser_files`, or a `data:` address holds it. */
  image_url?: string;
  /** The posters of the videos of the body (SPEC_CLIPPER.md, Б7). */
  video_posters?: Array<{ video_url: string; poster_url: string }> | null;
  /** What the browser did about each file of the clip (Б9). */
  browser_files?: BrowserFileEntry[];
  save_protocol?: unknown;
  required_capabilities?: unknown;
  [key: string]: unknown;
}

/** A save the folder holds. */
export type StandaloneCommitted = {
  ok: true;
  outcome: "committed";
  operation_id: string;
  binding_id: string;
  executor_id: "browser";
  standalone: true;
  slug: string;
  block_type: string;
  /** The reference cards name a new collection by. */
  tag?: string;
  /** The media that stayed links, each with its place in the text (Н10). */
  remote_media: StandaloneRemoteMedia[];
  /** Why each address stayed a link, with the code of the answer (Б13). */
  media_reasons?: StandaloneMediaReason[];
  /** Why the card has no preview (Б3). */
  warning?: string;
};

/** A save, lookup or listing that did not commit, and whether it may have. */
export type StandaloneFailure = {
  ok: false;
  outcome: SaveOutcome;
  operation_id?: string;
  executor_id: "browser";
  standalone: true;
  code: string;
  error: string;
  /** The collection a `collection_not_found` names. */
  collection?: string;
  binding_id?: string;
  /** The refusal is final for this operation id: a new save gets a new one. */
  terminal_rejected?: boolean;
  /** A lookup found the save prepared: saving again resumes it. */
  resumable?: boolean;
};

export type StandaloneSaveReply = StandaloneCommitted | StandaloneFailure | SaveProtocolRejection;

export type StandaloneChannelsReply = { ok: true; channels: CollectionCount[] } | StandaloneFailure;

/** A place of the text that stays a link to someone else's server (SPEC_DEEP_AUDIT.md, Н10). */
export interface StandaloneRemoteMedia {
  url: string;
  kind: "image" | "video" | "file" | "poster";
  reason: "download_failed" | "name";
}

/** Why a file was not obtained, in the clipper's words (Б3). */
export interface StandaloneMediaReason {
  url: string;
  reason: string;
}

/** The bytes of one file of a clip, kept until its operation ends (Б13). */
export interface StandalonePageFile {
  id: string;
  url: string;
  blob: Blob;
  size: number;
  /** SHA-256 of the SHA-256 of each 4 MiB part, lowercase hex. */
  hash: string;
  /** Milliseconds since the Unix epoch: a file nothing names goes after a day. */
  stored_at: number;
}

/** One file a prepared save publishes. The bytes wait in `page_files`. */
export interface StandaloneFileRecord {
  path: string;
  hash: string;
  size: number;
  upload_id?: string;
  /** The bytes of a medium of an entry written before this list; its `hash` is the plain SHA-256. */
  blob?: Blob;
}

/** The parts of a collection for a browser folder its worker provides. */
export interface StandaloneCollection extends Pick<PageFileWork, "signal" | "limiter" | "pageRead" | "request"> {
  /** Called with the id of each file as soon as it is kept. */
  stored(id: string): void;
}

/**
 * The medium of a save prepared before the list of files: its bytes and the path
 * it is published at. Only entries already in a journal hold one.
 */
export interface StandaloneMediaRecord {
  blob: Blob;
  extension: string;
  /** SHA-256 of the bytes, lowercase hex. */
  hash: string;
  path: string;
}

/** A save in the journal between its preparation and its receipt. */
export interface StandaloneOperationRecord {
  id: string;
  binding: string;
  fingerprint: string;
  kind: "capture" | "collection";
  phase: Exclude<SavePhase, "committed">;
  layout: VaultWriteLayoutDto;
  /** The folder was a new space when the save was prepared. */
  newSpace: boolean;
  slug: string;
  block_type: string;
  tag?: string;
  markdown: string;
  /** SHA-256 of `markdown`, lowercase hex. */
  hash: string;
  /** What the save publishes before the note, without its bytes (Б13). */
  files?: StandaloneFileRecord[];
  /** Every kept file the operation names, used or not: they go when it ends. */
  uploads?: string[];
  remote_media?: StandaloneRemoteMedia[];
  media_reasons?: StandaloneMediaReason[];
  warning?: string;
  /** An entry written before `files`. */
  media?: StandaloneMediaRecord | null;
}

/** The receipt of a committed save. */
export interface StandaloneReceipt {
  id: string;
  binding: string;
  fingerprint: string;
  phase: "committed";
  slug: string;
  block_type: string;
  kind: "capture" | "collection";
  tag?: string;
  remote_media?: StandaloneRemoteMedia[];
  media_reasons?: StandaloneMediaReason[];
  warning?: string;
}

/** A save refused before any effect; `response` is its final reply. */
export interface StandaloneRejection {
  id: string;
  binding: string;
  /** Absent when the refusal came before the request was fingerprinted. */
  fingerprint?: string;
  phase: "rejected";
  response: StandaloneFailure | SaveProtocolRejection;
}

export type StandaloneJournalEntry = StandaloneOperationRecord | StandaloneReceipt | StandaloneRejection;

/** A key-value journal: the operations, or what the collection list learned of the notes. */
export interface StandaloneStore {
  get(store: string, key: string): Promise<unknown>;
  put(store: string, key: string, value: unknown): Promise<unknown>;
  delete(store: string, key: string): Promise<unknown>;
  /** Every value of a store. */
  all(store: string): Promise<unknown[]>;
}

/** Seams of the browser executor for tests; the worker passes none. */
export interface StandaloneOptions {
  /** A folder to use instead of the chosen one. */
  directory?: FileSystemDirectoryHandle;
  /** The binding of `directory`; `test-vault` when absent. */
  binding_id?: string;
  /** The journal instead of IndexedDB. */
  store?: StandaloneStore;
  /** How the bytes of a screenshot or a `data:` address are read instead of `fetch`. */
  fetch?: (url: string) => Promise<Response>;
  /** Runs once the prepared save is in the journal, before any effect. */
  afterPrepared?: (record: StandaloneOperationRecord) => unknown;
  /** Runs after the medium or the note is published, before the journal records it. */
  afterEffect?: (effect: "media" | "markdown", record: StandaloneOperationRecord) => unknown;
}

declare global {
  // Chrome's File System Access methods that lib.dom does not declare: the
  // permission of a handle, and the entries of a directory (lib.dom has them
  // only in DOM.AsyncIterable).
  interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  var MineStandaloneVault: {
    /** Keep `handle` as the chosen folder; a folder chosen before keeps its binding. */
    storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void>;
    /** The folder of `bindingId`, else the chosen one; `null` when there is none. */
    loadDirectoryHandle(bindingId?: string): Promise<FileSystemDirectoryHandle | null>;
    /** Forget the chosen folder; pending operations keep their own. */
    clearDirectoryHandle(): Promise<void>;
    /** The layout the folder writes into, and whether it is a new space. */
    resolveLayout(handle: FileSystemDirectoryHandle): Promise<{ layout: VaultWriteLayoutDto; newSpace: boolean }>;
    /** Every path of the folder without its extension, hidden entries left out. */
    existingStems(handle: FileSystemDirectoryHandle): Promise<string[]>;
    getStandaloneStatus(options?: StandaloneOptions): Promise<StandaloneStatusReply>;
    saveStandaloneBlock(request: StandaloneSaveRequest, options?: StandaloneOptions): Promise<StandaloneSaveReply>;
    lookupOperation(id: string, bindingId: string, options?: StandaloneOptions): Promise<StandaloneSaveReply>;
    /** Create the page of collection `tag` in the folder of `bindingId`, else the chosen one. */
    createStandaloneChannel(tag: string, bindingId: string | null, options?: StandaloneOptions): Promise<StandaloneSaveReply>;
    listStandaloneChannels(options?: StandaloneOptions): Promise<StandaloneChannelsReply>;
    /** The files of a clip by the one route, their bytes kept for its Save (SPEC_CLIPPER.md, Б13). */
    collectPageFiles(request: PageFilesRequest, work: StandaloneCollection, options?: StandaloneOptions): Promise<BrowserFileEntry[]>;
    /** Remove the kept files of a collection whose clipper left before its Save. */
    discardPageFiles(ids: string[], options?: StandaloneOptions): Promise<void>;
    /** Remove what nothing names any more, older than a day; the worker runs it as it starts. */
    sweepPageFiles(namedByClipper: () => Promise<string[]>, options?: StandaloneOptions): Promise<void>;
  };
}
