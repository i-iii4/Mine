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
  [key: string]: unknown;
}

export interface ChannelInfo {
  tag: string;
  title: string;
  block_count: number;
}

const TIMEOUT_MS = 10_000;

export async function sendToNative(payload: NativeRequest): Promise<NativeResponse> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: "Native host timeout" });
    }, TIMEOUT_MS);

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

export interface ContextMenuData {
  menuItemId: string;
  srcUrl?: string;
  selectionText?: string;
  linkUrl?: string;
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
  imageToSave?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
}

export interface ArticleData {
  title: string;
  content: string;
  byline: string | null;
  excerpt: string;
}

export async function extractMetadata(tabId: number): Promise<PageMetadata> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
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
    }, 5_000);

    chrome.tabs.sendMessage(tabId, { action: "extractMetadata" }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError || !resp) {
        resolve({
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
      } else {
        resolve(resp as PageMetadata);
      }
    });
  });
}

export async function extractArticle(tabId: number): Promise<ArticleData> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ title: "", content: "", byline: null, excerpt: "" });
    }, 10_000);

    chrome.tabs.sendMessage(tabId, { action: "extractArticle" }, (resp) => {
      clearTimeout(timer);
      resolve((resp as ArticleData) ?? { title: "", content: "", byline: null, excerpt: "" });
    });
  });
}

export async function getImageInfo(
  tabId: number,
  src: string,
): Promise<{ alt?: string; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 3_000);

    chrome.tabs.sendMessage(tabId, { action: "getImageInfo", src }, (resp) => {
      clearTimeout(timer);
      resolve((resp as { alt?: string; width?: number; height?: number }) ?? {});
    });
  });
}
