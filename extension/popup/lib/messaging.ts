// Native messaging adapter — typed wrapper over chrome.runtime.sendMessage.
// Replaces FIFO queue with Map<id, callback> (fixes CRIT-7 from audit).
import "../../lib/youtubeSource.js";
import type { SaveExecutor, SaveOutcome } from "../../../src/types/generated";

export interface NativeRequest {
  action: string;
  [key: string]: unknown;
}

export interface NativeResponse {
  ok: boolean;
  error?: string;
  channels?: ChannelInfo[];
  features?: string[];
  host_api_version?: number;
  connected?: boolean;
  vaultConfigured?: boolean;
  vault_path?: string | null;
  binding_id?: string | null;
  /// К1 to К5: identity, move and settings generation of the chosen space.
  vault_id?: string | null;
  moved_from?: string | null;
  binding_accepted?: boolean;
  config_generation?: number;
  folder_state?: string;
  executor_id?: SaveExecutor;
  outcome?: SaveOutcome;
  code?: string;
  warning?: string;
  [key: string]: unknown;
}

export interface ChannelInfo {
  tag: string;
  /** `null` while the space is being indexed and counts are not known. */
  block_count: number | null;
}

/** A popup/background channel failure is not evidence about native-host availability. */
export function extensionTransportFailure(transportError?: string): NativeResponse {
  return {
    ok: false,
    error: "Mine extension background stopped before replying. Retry this action.",
    code: "extension_transport",
    outcome: "unknown",
    transport_error: transportError ?? "The extension runtime did not provide a transport error.",
  };
}

// save_block в native_host синхронно качает inline-картинки статьи —
// must mirror background.js timeoutForAction(). Остальные actions —
// быстрый read-only IPC через bg.js port.
function timeoutForAction(action: string): number {
  if (action === "save_block") return 180_000;
  // The folder chooser waits on a human: the promise resolves when the
  // dialog does, not on IPC speed.
  if (action === "pick_vault_folder") return 300_000;
  return 30_000;
}

export async function sendToNative(payload: NativeRequest): Promise<NativeResponse> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: "Mine helper did not respond in time", outcome: "unknown", code: "native_timeout" });
    }, timeoutForAction(payload.action));

    chrome.runtime.sendMessage(
      { target: "background", action: "nativeMessage", payload },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve(extensionTransportFailure(chrome.runtime.lastError.message));
        } else {
          resolve((response as NativeResponse) ?? { ok: false, error: "No response" });
        }
      },
    );
  });
}

/// One opening of the clipper (SPEC_AUDIT_FIXES.md, Ф6): the page it opened
/// for and what that opening brought along. Only the clipper that opened for
/// the source tab receives it.
export interface ClipperLaunch {
  sourceTabId: number;
  sourceUrl: string | null;
  sourceTitle: string | null;
  contextMenu: ContextMenuData | null;
  preloaded: { metadata: PageMetadata; article: ArticleData } | null;
}

export async function getClipperLaunch(): Promise<ClipperLaunch | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3_000);

    chrome.runtime.sendMessage(
      { target: "background", action: "getClipperLaunch" },
      (data) => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        resolve((data as ClipperLaunch | null) ?? null);
      },
    );
  });
}

/** How long Save waits for a YouTube channel that has not answered yet; the
 *  background request has the same bound (SPEC_CARD_ASSOCIATIONS.md,
 *  «Клиппер: канал YouTube»). */
export const YOUTUBE_CHANNEL_TIMEOUT_MS = globalThis.MineYoutubeSource.YOUTUBE_CHANNEL_TIMEOUT_MS;

/** What background answers to `resolveYoutubeChannel`. */
interface YoutubeChannelReply {
  channel?: unknown;
}

/**
 * Asks background for the channel of the YouTube video at `sourceUrl`.
 * Every failure, a stopped background included, answers `null`: the clip is
 * then saved without an author, never held back.
 */
export function requestYoutubeChannel(sourceUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { target: "background", action: "resolveYoutubeChannel", sourceUrl },
        (response: YoutubeChannelReply | undefined) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          const channel = typeof response?.channel === "string" ? response.channel.trim() : "";
          resolve(channel || null);
        },
      );
    } catch (error) {
      // An invalidated extension context throws here instead of calling back.
      console.warn("[Mine] YouTube channel request failed:", error);
      resolve(null);
    }
  });
}

/** What background answers to `readXSyndication`. */
interface XSyndicationReply {
  ok?: boolean;
  data?: unknown;
}

/** The syndication answer of an X post, as the service gives it. */
export type XSyndicationData = Record<string, unknown>;

function isXSyndicationData(value: unknown): value is XSyndicationData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asks background for the syndication answer of the X post `tweetId`
 * (SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 6). The service answers
 * only https://platform.twitter.com: the overlay runs in the page's content
 * script, where a request of its own fails on CORS (13.10.2026). Every
 * failure, a stopped background included, answers `null`.
 */
export function requestXSyndication(tweetId: string): Promise<XSyndicationData | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { target: "background", action: "readXSyndication", tweetId },
        (response: XSyndicationReply | undefined) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response?.ok === true && isXSyndicationData(response.data) ? response.data : null);
        },
      );
    } catch (error) {
      // An invalidated extension context throws here instead of calling back.
      console.warn("[Mine] X post request failed:", error);
      resolve(null);
    }
  });
}

/**
 * The channel answer, waited for at most `timeoutMs`. No answer by then or a
 * failed request give `null`, so Save goes on without an author.
 */
export async function waitForYoutubeChannel(
  answer: Promise<string | null>,
  timeoutMs: number = YOUTUBE_CHANNEL_TIMEOUT_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([answer.catch(() => null), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface KnownVaultsResponse extends NativeResponse {
  vaults: string[];
  current: string | null;
}

export async function listKnownVaults(): Promise<KnownVaultsResponse> {
  const resp = await sendToNative({ action: "list_known_vaults" });
  return resp as KnownVaultsResponse;
}

export interface PickVaultFolderResponse extends NativeResponse {
  cancelled: boolean;
  path: string | null;
  vaults: string[];
}

/// Asks the native host to show the system folder chooser and register the
/// picked folder as a known vault. The extension has no filesystem UI of its
/// own; the host, an ordinary local process, opens the dialog on its behalf.
export async function pickVaultFolder(): Promise<PickVaultFolderResponse> {
  const resp = await sendToNative({ action: "pick_vault_folder" });
  return resp as PickVaultFolderResponse;
}

/// Reveals a known space in Finder via the native host. The binding lets
/// the host find a space that moved since the popup saw it (К6).
export async function revealVault(path: string, bindingId: string | null = null): Promise<NativeResponse> {
  return sendToNative({ action: "reveal_vault", path, binding_id: bindingId });
}

export interface ContextMenuData {
  menuItemId: string;
  srcUrl?: string;
  selectionText?: string;
  linkUrl?: string;
  pageUrl?: string;
  frameUrl?: string;
}

export interface PageMetadata {
  /** Navigation generation shared with asynchronous extraction. */
  captureGeneration?: string;
  /** Raw document address at capture start; separate from normalized Source. */
  documentUrl?: string;
  url: string;
  title: string;
  description: string;
  image: string | null;
  author: string | null;
  ogType: string | null;
  favicon: string | null;
  selection: string;
  detectedType: string;
  isArticle: boolean;
  bodyText?: string;
  imageToSave?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
}

export interface ArticleData {
  captureGeneration?: string;
  /** Structured X posts retain media ownership through authenticated recovery. */
  twitterPosts?: import("../../lib/xThread").XPostContent[];
  documentUrl?: string;
  /** Source captured with the extracted content, never inferred at save time. */
  sourceUrl?: string;
  threadWarning?: string;
  threadPostCount?: number;
  title: string;
  content: string;
  html?: string;
  byline: string | null;
  excerpt: string;
  embeddedVideos?: EmbeddedVideoPreview[];
  /// The page shows a player, but no path available to the content script could
  /// resolve a URL for it — an age-restricted post, where the public API
  /// answers with a tombstone and the DOM only holds a `blob:` URL. The save
  /// path asks the background script, which has the session cookies.
  needsAuthenticatedVideo?: boolean;
  tweetUrl?: string;
  tweetId?: string;
  /** Why a video of the post could not be got: the helper's video tool
   *  failed or is known not to work. The post is saved without it
   *  (SPEC_CLIPPER.md, 3d, В4). */
  videoNotice?: string;
  /** Why the post brought by an X feed button could not be read; shown in
   *  place of the preview (SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 7). */
  unavailableReason?: string;
}

export interface EmbeddedVideoPreview {
  src: string | null;
  poster: string | null;
  title: string;
  currentTime?: number | null;
}

// Extractors work in two contexts:
//
//   - Window context (detached popup fallback, tabId known): dispatch via
//     chrome.tabs.sendMessage(tabId, ...) → content.js message handler.
//
//   - Content-script context (overlay entry injected into the active tab):
//     call window.__mineClipper.extractMetadata(document) directly. No
//     round-trip, no messaging, since overlay-entry and content.js share
//     the same isolated-world `window`.
//
// The TAB_ID sentinel -1 means "we're running inside the content script".

export const CONTENT_SCRIPT_CONTEXT = -1;

// Frozen: every caller gets a copy, which it fills with the tab's address and
// title. Handed out itself, it kept them for the next opening on another page
// (SPEC_DEEP_AUDIT.md, Е3.4).
const EMPTY_METADATA: Readonly<PageMetadata> = Object.freeze({
  url: "",
  title: "",
  description: "",
  image: null,
  author: null,
  ogType: null,
  favicon: null,
  selection: "",
  detectedType: "link",
  isArticle: false,
});

const EMPTY_ARTICLE: Readonly<ArticleData> = Object.freeze({ title: "", content: "", byline: null, excerpt: "" });

export interface TwitterLightboxResult {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

interface MineContentHelpers {
  extractMetadata: () => PageMetadata;
  extractArticle: () => ArticleData;
  extractArticleAsync: () => Promise<ArticleData>;
  getImageInfo: (src: string) => { src: string; alt: string | null; title: string | null; width: number | null; height: number | null; postUrl?: string | null };
  detectTwitterLightboxImage: () => TwitterLightboxResult | null;
  captureDocumentSnapshot?: () => CaptureDocument;
}

/** The document the page shows now: its address and navigation generation. */
export interface CaptureDocument {
  documentUrl: string;
  captureGeneration: string;
}

/// The document this page shows now, read in the overlay's own page; `null`
/// outside a page or where the content script predates the snapshot.
export function currentCaptureDocument(): CaptureDocument | null {
  return contentHelpers()?.captureDocumentSnapshot?.() ?? null;
}

function contentHelpers(): MineContentHelpers | null {
  const w = globalThis as unknown as { __mineClipper?: MineContentHelpers };
  return w.__mineClipper ?? null;
}

export async function extractMetadata(tabId: number): Promise<PageMetadata> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    return helpers ? helpers.extractMetadata() : { ...EMPTY_METADATA };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ...EMPTY_METADATA }), 5_000);
    chrome.tabs.sendMessage(tabId, { action: "extractMetadata" }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError || !resp) {
        resolve({ ...EMPTY_METADATA });
      } else {
        resolve(resp as PageMetadata);
      }
    });
  });
}

export async function extractArticle(tabId: number): Promise<ArticleData> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    return helpers ? helpers.extractArticle() : { ...EMPTY_ARTICLE };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ...EMPTY_ARTICLE }), 10_000);
    chrome.tabs.sendMessage(tabId, { action: "extractArticle" }, (resp) => {
      clearTimeout(timer);
      resolve((resp as ArticleData) ?? { ...EMPTY_ARTICLE });
    });
  });
}

export async function extractArticleAsync(tabId: number): Promise<ArticleData> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    return helpers ? await helpers.extractArticleAsync() : { ...EMPTY_ARTICLE };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ...EMPTY_ARTICLE }), 30_000);
    chrome.tabs.sendMessage(tabId, { action: "extractArticleAsync" }, (resp) => {
      clearTimeout(timer);
      resolve((resp as ArticleData) ?? { ...EMPTY_ARTICLE });
    });
  });
}

/** Upload binary data to native host's HTTP server. Returns filename. */
export async function uploadFile(
  port: number,
  token: string,
  filename: string,
  screenshotId: string,
  vaultPath?: string | null,
): Promise<{ ok: boolean; filename?: string; upload_id?: string; error?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: "Upload timeout" });
    }, 30_000);

    chrome.runtime.sendMessage(
      {
        target: "background",
        action: "uploadFile",
        payload: {
          port,
          token,
          filename,
          screenshotId,
          vaultPath: vaultPath ?? null,
        },
      },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve((response as { ok: boolean; filename?: string; upload_id?: string; error?: string }) ?? {
          ok: false,
          error: "No upload response",
        });
      },
    );
  });
}

export async function cacheScreenshotUpload(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { target: "background", action: "cacheScreenshotUpload", dataUrl },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp?.ok && resp.screenshotId ? resp.screenshotId : null);
      },
    );
  });
}

export async function getImageInfo(
  tabId: number,
  src: string,
): Promise<{ alt?: string; width?: number; height?: number; postUrl?: string | null }> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    if (!helpers) return {};
    const info = helpers.getImageInfo(src);
    return {
      alt: info.alt ?? undefined,
      width: info.width ?? undefined,
      height: info.height ?? undefined,
      postUrl: info.postUrl ?? null,
    };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 3_000);
    chrome.tabs.sendMessage(tabId, { action: "getImageInfo", src }, (resp) => {
      clearTimeout(timer);
      resolve((resp as { alt?: string; width?: number; height?: number; postUrl?: string | null }) ?? {});
    });
  });
}

export async function detectTwitterLightbox(
  tabId: number,
): Promise<TwitterLightboxResult | null> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    return helpers?.detectTwitterLightboxImage() ?? null;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3_000);
    chrome.tabs.sendMessage(tabId, { action: "detectTwitterLightboxImage" }, (resp) => {
      clearTimeout(timer);
      resolve((resp as TwitterLightboxResult) ?? null);
    });
  });
}
