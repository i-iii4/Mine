// Native messaging adapter — typed wrapper over chrome.runtime.sendMessage.
// Replaces FIFO queue with Map<id, callback> (fixes CRIT-7 from audit).

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
  [key: string]: unknown;
}

export interface ChannelInfo {
  tag: string;
  block_count: number;
}

// save_block в native_host синхронно качает inline-картинки статьи —
// must mirror background.js timeoutForAction(). Остальные actions —
// быстрый read-only IPC через bg.js port.
function timeoutForAction(action: string): number {
  return action === "save_block" ? 180_000 : 10_000;
}

export async function sendToNative(payload: NativeRequest): Promise<NativeResponse> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: "Native host timeout" });
    }, timeoutForAction(payload.action));

    chrome.runtime.sendMessage(
      { target: "background", action: "nativeMessage", payload },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve((response as NativeResponse) ?? { ok: false, error: "No response" });
        }
      },
    );
  });
}

export async function getContextMenuData(): Promise<ContextMenuData | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3_000);

    chrome.runtime.sendMessage(
      { target: "background", action: "getContextMenuData" },
      (data) => {
        clearTimeout(timer);
        resolve((data as ContextMenuData) ?? null);
      },
    );
  });
}

export interface KnownVaultsResponse extends NativeResponse {
  vaults: string[];
  current: string | null;
}

export async function listKnownVaults(): Promise<KnownVaultsResponse> {
  const resp = await sendToNative({ action: "list_known_vaults" });
  return resp as KnownVaultsResponse;
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
  title: string;
  content: string;
  html?: string;
  byline: string | null;
  excerpt: string;
  embeddedVideos?: EmbeddedVideoPreview[];
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

const EMPTY_METADATA: PageMetadata = {
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
};

const EMPTY_ARTICLE: ArticleData = { title: "", content: "", byline: null, excerpt: "" };

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
  getImageInfo: (src: string) => { src: string; alt: string | null; title: string | null; width: number | null; height: number | null };
  detectTwitterLightboxImage: () => TwitterLightboxResult | null;
}

function contentHelpers(): MineContentHelpers | null {
  const w = globalThis as unknown as { __mineClipper?: MineContentHelpers };
  return w.__mineClipper ?? null;
}

export async function extractMetadata(tabId: number): Promise<PageMetadata> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    return helpers ? helpers.extractMetadata() : EMPTY_METADATA;
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
): Promise<{ alt?: string; width?: number; height?: number }> {
  if (tabId === CONTENT_SCRIPT_CONTEXT) {
    const helpers = contentHelpers();
    if (!helpers) return {};
    const info = helpers.getImageInfo(src);
    return {
      alt: info.alt ?? undefined,
      width: info.width ?? undefined,
      height: info.height ?? undefined,
    };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 3_000);
    chrome.tabs.sendMessage(tabId, { action: "getImageInfo", src }, (resp) => {
      clearTimeout(timer);
      resolve((resp as { alt?: string; width?: number; height?: number }) ?? {});
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
