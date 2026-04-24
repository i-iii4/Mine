import { useState, useEffect, useCallback, useRef } from "react";

/** Remove duplicate images from markdown by comparing alt text.
 *  If two images have identical alt text, the second is a duplicate (e.g. OG hero + body image). */
function deduplicateImages(markdown: string): string {
  const imgRegex = /!\[([^\]]*)\]\([^)]+\)/g;
  const matches = [...markdown.matchAll(imgRegex)];
  if (matches.length < 2) return markdown;

  const seen = new Set<string>();
  let result = markdown;
  for (const match of matches) {
    const imageMarkdown = match[0];
    const altText = match[1];
    if (!imageMarkdown || altText === undefined) continue;
    const alt = altText.trim();
    if (!alt) continue;
    if (seen.has(alt)) {
      // Remove this duplicate line and its caption
      const lines = result.split("\n");
      const idx = lines.findIndex((l) => l.includes(imageMarkdown));
      if (idx >= 0) {
        lines.splice(idx, 1);
        const lineAfterImage = lines[idx];
        if (lineAfterImage !== undefined && lineAfterImage.trim() === "") {
          lines.splice(idx, 1);
        }
        const captionLine = lines[idx];
        if (captionLine !== undefined && captionLine.trim() === alt) {
          lines.splice(idx, 1);
          const spacerLine = lines[idx];
          if (spacerLine !== undefined && spacerLine.trim() === "") {
            lines.splice(idx, 1);
          }
        }
        result = lines.join("\n");
      }
    } else {
      seen.add(alt);
    }
  }
  return result;
}
import {
  sendToNative,
  listKnownVaults,
  uploadFile,
  getContextMenuData,
  extractMetadata,
  extractArticle,
  extractArticleAsync,
  getImageInfo,
  detectTwitterLightbox,
  CONTENT_SCRIPT_CONTEXT,
  type NativeRequest,
  type ChannelInfo,
  type PageMetadata,
  type ArticleData,
  type ContextMenuData,
} from "../lib/messaging";

// Detection: when PopupApp runs as a content-script overlay, chrome.tabs /
// chrome.action are not exposed to that execution context. The window-entry
// fallback (detached popup window) still has them.
const IS_CONTENT_SCRIPT_CONTEXT = typeof chrome.tabs === "undefined";

import { resolveContentBody } from "../lib/resolveContentBody";

export type ClipType = "content" | "link" | "image" | "video" | "screenshot";
export type PopupState = "loading" | "error" | "main";

export interface ClipperState {
  state: PopupState;
  error: string | null;
  metadata: PageMetadata | null;
  articleData: ArticleData | null;
  channels: ChannelInfo[];
  selectedTags: string[];
  recentTags: string[];
  currentType: ClipType;
  title: string;
  saving: boolean;
  knownVaults: string[];
  selectedVault: string | null;
}

export function useClipperState() {
  const [state, setState] = useState<PopupState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<PageMetadata | null>(null);
  const [articleData, setArticleData] = useState<ArticleData | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [recentTags, setRecentTags] = useState<string[]>([]);
  const [currentType, setCurrentType] = useState<ClipType>("link");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [articleLoading, setArticleLoading] = useState(false);
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [screenshotUploadId, setScreenshotUploadId] = useState<string | null>(null);
  const [cropSupported, setCropSupported] = useState<boolean>(false);
  const uploadPortRef = useRef<number | null>(null);
  const uploadTokenRef = useRef<string | null>(null);

  const tabIdRef = useRef<number | null>(null);
  const vaultRef = useRef<string | null>(null);
  const deferredArticleRef = useRef<ArticleData | null>(null);

  const captureScreenshot = useCallback(() => {
    // Hide the overlay before capture so the clipper UI doesn't appear
    // in the screenshot. In overlay context __mineOverlay is exposed by
    // overlay-entry.tsx on the isolated-world window; in window-entry
    // context it's undefined and we skip the hide step entirely.
    const overlay = (globalThis as unknown as {
      __mineOverlay?: { hide: () => void; show: () => void };
    }).__mineOverlay;

    function showAgain() {
      if (overlay) {
        // One animation frame so React + paint complete before we
        // restore the overlay — avoids a visible flash mid-capture.
        requestAnimationFrame(() => overlay.show());
      }
    }

    if (IS_CONTENT_SCRIPT_CONTEXT) {
      overlay?.hide();
      // Wait two animation frames: one for the host display:none to
      // apply, one for the browser to paint without the overlay. Only
      // then does captureVisibleTab see a clean viewport.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chrome.runtime.sendMessage(
            { target: "background", action: "captureForCrop" },
            (resp) => {
              showAgain();
              if (chrome.runtime.lastError) {
                showError(`Screenshot failed: ${chrome.runtime.lastError.message}`);
                return;
              }
              if (resp?.ok && resp.dataUrl) {
                setScreenshotDataUrl(resp.dataUrl);
                if (resp.screenshotId) {
                  setScreenshotUploadId(resp.screenshotId);
                } else {
                  cacheCapturedScreenshot(resp.dataUrl);
                }
              } else {
                showError(resp?.error ?? "Screenshot capture failed");
              }
            },
          );
        });
      });
      return;
    }
    chrome.tabs.captureVisibleTab(
      null as unknown as number,
      { format: "jpeg", quality: 85 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          showError(`Screenshot failed: ${chrome.runtime.lastError.message}`);
          return;
        }
        if (!dataUrl) return;
        setScreenshotDataUrl(dataUrl);
        cacheCapturedScreenshot(dataUrl);
      },
    );
  }, []);

  const handleTypeChange = useCallback((type: ClipType) => {
    setCurrentType(type);
    if (type === "screenshot" && !screenshotDataUrl) {
      captureScreenshot();
    }
  }, [screenshotDataUrl, captureScreenshot]);

  const retakeScreenshot = useCallback(() => {
    captureScreenshot();
  }, [captureScreenshot]);

  function cacheCapturedScreenshot(dataUrl: string) {
    chrome.runtime.sendMessage(
      { target: "background", action: "cacheScreenshotUpload", dataUrl },
      (resp) => {
        if (chrome.runtime.lastError) {
          setScreenshotUploadId(null);
          return;
        }
        setScreenshotUploadId(resp?.ok && resp.screenshotId ? resp.screenshotId : null);
      },
    );
  }

  const startCropMode = useCallback(async () => {
    if (!cropSupported || tabIdRef.current === null) return;

    if (IS_CONTENT_SCRIPT_CONTEXT) {
      // Overlay context: hide the clipper overlay, trigger the crop
      // overlay in the same content script. React state stays alive in
      // memory — no persist, no rehydrate, no toast. When crop completes,
      // content.js calls window.__mineOverlay.show() which reveals us
      // again, and dispatches a mine-crop-result event we listen to.
      const overlay = (globalThis as unknown as { __mineOverlay?: { hide: () => void } }).__mineOverlay;
      overlay?.hide();
      chrome.runtime.sendMessage(
        { target: "background", action: "startCropMode", tabId: tabIdRef.current },
        () => void chrome.runtime.lastError,
      );
      return;
    }

    // Window-entry fallback: persist state + close popup + rehydrate on return.
    await chrome.storage.session.set({
      cropPendingState: {
        tabId: tabIdRef.current,
        metadata,
        articleData,
        selectedTags,
        recentTags,
        title,
        currentType,
        selectedVault: vaultRef.current,
        screenshotDataUrl,
        screenshotUploadId,
      },
    });

    const response = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage(
        {
          target: "background",
          action: "startCropMode",
          tabId: tabIdRef.current,
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp ?? { ok: false, error: "No response" });
          }
        },
      );
    });

    if (!response.ok) {
      await chrome.storage.session.remove("cropPendingState");
      showError(response.error ?? "Failed to start crop mode. Try reloading the tab.");
      return;
    }

    window.close();
  }, [
    cropSupported,
    metadata,
    articleData,
    selectedTags,
    recentTags,
    title,
    currentType,
    screenshotDataUrl,
    screenshotUploadId,
  ]);

  // Overlay context: listen for crop result event dispatched by content.js
  useEffect(() => {
    if (!IS_CONTENT_SCRIPT_CONTEXT) return;
    function onCropResult(e: Event) {
      const { detail } = e as CustomEvent<{ dataUrl?: string; screenshotId?: string | null }>;
      if (detail?.dataUrl && detail.screenshotId) {
        setScreenshotDataUrl(detail.dataUrl);
        setScreenshotUploadId(detail.screenshotId);
      }
    }
    window.addEventListener("mine-crop-result", onCropResult);
    return () => window.removeEventListener("mine-crop-result", onCropResult);
  }, []);

  // --- Init ---

  useEffect(() => {
    init();
  }, []);

  async function init() {
    try {
      // chrome.action is a service-worker API and is not exposed to the
      // content-script isolated world where the overlay runs.
      if (chrome.action?.setBadgeText) {
        chrome.action.setBadgeText({ text: "" });
      }

      const stored = await chrome.storage.local.get("recentChannels");
      const recent = (stored.recentChannels as string[]) ?? [];
      setRecentTags(recent);

      const status = await sendToNative({ action: "get_status" });
      if (!status.ok) {
        showError(status.error ?? "Cannot connect to Mine");
        return;
      }
      uploadPortRef.current = (status.upload_port as number) ?? null;
      uploadTokenRef.current = (status.upload_token as string) ?? null;

      // Load known vaults
      const vaultsResult = await listKnownVaults();
      if (vaultsResult.ok) {
        setKnownVaults(vaultsResult.vaults);
        setSelectedVault(vaultsResult.current);
        vaultRef.current = vaultsResult.current;
      }

      const chResult = await sendToNative({ action: "list_channels" });
      if (chResult.ok && chResult.channels) {
        setChannels(chResult.channels);
      }

      // Check for pre-loaded data (from Instagram feed button)
      const preloaded = await chrome.storage.session.get("preloadedClipData");
      if (preloaded.preloadedClipData) {
        const { metadata: preMeta, article: preArticle } = preloaded.preloadedClipData as { metadata: PageMetadata; article: ArticleData };
        chrome.storage.session.remove("preloadedClipData");

        setMetadata(preMeta as PageMetadata);
        setArticleData(preArticle as ArticleData);
        setTitle(preMeta.title ?? "");
        setCurrentType("content");
        setState("main");
        return;
      }

      // Check for crop mode result — popup was reopened after user finished cropping
      const cropData = await chrome.storage.session.get(["cropPendingState", "cropResult"]);
      if (cropData.cropPendingState && cropData.cropResult) {
        const pending = cropData.cropPendingState as {
          tabId: number;
          metadata: PageMetadata | null;
          articleData: ArticleData | null;
          selectedTags: string[];
          recentTags: string[];
          title: string;
          currentType: ClipType;
          selectedVault: string | null;
          screenshotDataUrl: string | null;
          screenshotUploadId: string | null;
        };
        const result = cropData.cropResult as {
          status: "done" | "cancelled";
          dataUrl?: string;
          screenshotId?: string;
        };

        chrome.storage.session.remove(["cropPendingState", "cropResult"]);

        tabIdRef.current = pending.tabId;
        vaultRef.current = pending.selectedVault;
        setSelectedVault(pending.selectedVault);
        setMetadata(pending.metadata);
        setArticleData(pending.articleData);
        setSelectedTags(pending.selectedTags);
        setRecentTags(pending.recentTags);
        setTitle(pending.title);
        setCurrentType(pending.currentType);

        if (result.status === "done" && result.dataUrl) {
          setScreenshotDataUrl(result.dataUrl);
          setScreenshotUploadId(result.screenshotId ?? null);
        } else {
          // Cancelled — keep previous (un-cropped) screenshot
          setScreenshotDataUrl(pending.screenshotDataUrl);
          setScreenshotUploadId(pending.screenshotUploadId);
        }

        // Re-check crop capability for the same tab (window-entry only —
        // content-script overlay doesn't use this rehydrate path at all)
        let tabUrl: string | null = null;
        if (!IS_CONTENT_SCRIPT_CONTEXT && pending.tabId !== null && chrome.tabs?.get) {
          const t = await chrome.tabs.get(pending.tabId).catch(() => null);
          tabUrl = t?.url ?? null;
        }
        applyCropCapability(tabUrl);

        setState("main");
        return;
      }

      const ctxData = await getContextMenuData();

      // Resolve the target tab: in content-script context we ARE the tab,
      // so we use the sentinel tabId and read URL/title from window+document.
      // In window-entry (detached popup) context we query Chrome for the
      // currently active tab.
      let tabId: number;
      let tabUrl: string | undefined;
      let tabTitle: string | undefined;
      if (IS_CONTENT_SCRIPT_CONTEXT) {
        tabId = CONTENT_SCRIPT_CONTEXT;
        tabUrl = window.location.href;
        tabTitle = document.title;
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          showError("Cannot access current tab");
          return;
        }
        tabId = tab.id;
        tabUrl = tab.url;
        tabTitle = tab.title;
      }
      tabIdRef.current = tabId;
      applyCropCapability(tabUrl ?? null);

      let [meta, article] = await Promise.all([
        extractMetadata(tabId),
        extractArticle(tabId),
      ]);

      // Apply tab fallbacks
      if (!meta.url && tabUrl) meta.url = tabUrl;
      if (!meta.title && tabTitle) meta.title = tabTitle;

      // Apply context menu overrides
      if (ctxData) {
        await applyContextMenu(ctxData, meta, tabId);
      }

      // Deduplicate images with identical alt text (e.g. OG hero + same image in body)
      if (article.content) {
        article.content = deduplicateImages(article.content);
      }

      setMetadata(meta);
      // If save-link fetched tweet data via syndication API, use it
      if (deferredArticleRef.current) {
        article = deferredArticleRef.current;
        if (article.title) meta.title = article.title;
        deferredArticleRef.current = null;
      }
      setArticleData(article);
      setTitle(meta.title ?? "");

      // Map detected type. Precedence (see SPEC_CLIPPER.md § Auto-detection):
      //   selection  → Content (quote takes over the preview via resolveContentBody)
      //   image      → Image-only view (TypeSwitcher hidden in PopupApp)
      //   article    → Content
      //   video      → Content (video block, transcript in body)
      //   link/other → Screenshot (default visual clip for everything else)
      let detected: ClipType;
      const dt = meta.detectedType;
      if (dt === "selection" || dt === "article" || dt === "content" || dt === "video") {
        detected = "content";
      } else if (dt === "image") {
        detected = "image";
      } else {
        detected = "screenshot";
      }
      setCurrentType(detected);
      if (detected === "screenshot") {
        captureScreenshot();
      }

      setState("main");

      // Background: fetch async article for video (YouTube transcript) and Twitter (syndication API)
      const needsAsync = meta.detectedType === "video"
        || (meta.detectedType === "article" && !article.content);
      if (needsAsync) {
        setArticleLoading(true);
        extractArticleAsync(tabId).then((asyncArticle) => {
          if (asyncArticle.content) {
            setArticleData(asyncArticle);
            // Update title from async data (Twitter/Instagram return better titles than og:title)
            if (asyncArticle.title) {
              setTitle(asyncArticle.title);
            }
          }
          setArticleLoading(false);
        });
      }
    } catch (e) {
      showError("Failed to initialize: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function applyCropCapability(url: string | null) {
    if (!url) {
      setCropSupported(false);
      return;
    }
    try {
      const u = new URL(url);
      // Content scripts only run on http/https/file — everything else (chrome://,
      // chrome-extension://, chrome.google.com/webstore, view-source:) is off-limits.
      if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") {
        if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) {
          setCropSupported(false);
          return;
        }
        setCropSupported(true);
        return;
      }
      setCropSupported(false);
    } catch {
      setCropSupported(false);
    }
  }

  async function applyContextMenu(ctx: ContextMenuData, meta: PageMetadata, tabId: number) {
    switch (ctx.menuItemId) {
      case "save-image":
        meta.detectedType = "image";
        meta.imageToSave = ctx.srcUrl;
        if (ctx.srcUrl) {
          try {
            const info = await getImageInfo(tabId, ctx.srcUrl);
            if (info.alt) meta.imageAlt = info.alt;
            if (info.width) meta.imageWidth = info.width;
            if (info.height) meta.imageHeight = info.height;
          } catch {
            // Optional — ignore
          }
        }
        break;
      case "save-selection":
        meta.detectedType = "selection";
        meta.selection = ctx.selectionText ?? meta.selection;
        break;
      case "save-link":
        if (ctx.linkUrl) meta.url = ctx.linkUrl;
        // Twitter/X tweet links: fetch full tweet (text + images) via
        // syndication API directly from popup — no content script needed,
        // works even when current page is the feed, not the tweet page.
        if (ctx.linkUrl && /(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i.test(ctx.linkUrl)) {
          meta.detectedType = "article";
          const tweetMatch = ctx.linkUrl.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i);
          if (tweetMatch) {
            const [, handle, tweetId] = tweetMatch;
            try {
              const tweet = await fetchTweetBySyndicationApi(tweetId!, `@${handle}`);
              if (tweet) {
                deferredArticleRef.current = tweet;
              }
            } catch {
              // Fall through — save as article without media
            }
          }
        } else {
          meta.detectedType = "link";
        }
        break;
      case "save-page": {
        // Twitter lightbox: user right-clicked on the overlay image but
        // Chrome didn't detect an <img> context (transparent element on
        // top). Check if a lightbox is open and extract the image URL.
        const pageUrl = meta.url || "";
        if (pageUrl.includes("x.com/") || pageUrl.includes("twitter.com/")) {
          try {
            const lightbox = await detectTwitterLightbox(tabId);
            if (lightbox?.src) {
              meta.detectedType = "image";
              meta.imageToSave = lightbox.src;
              if (lightbox.alt) meta.imageAlt = lightbox.alt;
              if (lightbox.width) meta.imageWidth = lightbox.width;
              if (lightbox.height) meta.imageHeight = lightbox.height;
            }
          } catch {
            // Fall through to default page save
          }
        }
        break;
      }
    }
  }

  function showError(msg: string) {
    setError(msg);
    setState("error");
  }

  // --- Actions ---

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  const createChannel = useCallback(async (name: string) => {
    await sendToNative({ action: "create_channel", tag: name, title: name, vault_path: vaultRef.current });
    setChannels((prev) => [...prev, { tag: name, title: name, block_count: 0 }]);
    setSelectedTags((prev) => [...prev, name]);
  }, []);

  const save = useCallback(async () => {
    if (!metadata || saving) return;

    setSaving(true);

    // Re-query selection before saving
    if (currentType === "content" && metadata.selection?.length > 0 && tabIdRef.current) {
      try {
        const fresh = await extractMetadata(tabIdRef.current);
        if (fresh.selection?.length > 0) {
          metadata.selection = fresh.selection;
        }
      } catch {
        // Use existing selection
      }
    }

    let blockType: string;
    if (currentType === "content") {
      blockType = metadata.detectedType === "video" ? "video" : "article";
    } else if (currentType === "image" || currentType === "screenshot") blockType = "image";
    else blockType = currentType;

    const payload: NativeRequest = {
      action: "save_block",
      vault_path: vaultRef.current,
      block_type: blockType,
      title: title || null,
      description: null,
      url: metadata.url || null,
      body: "",
      tags: selectedTags.length > 0 ? selectedTags : null,
      image_url: null,
      author: metadata.author || null,
      width: null,
      height: null,
    };

    if (currentType === "content") {
      const resolved = resolveContentBody(metadata, articleData);
      payload.body = resolved.text;
      if (resolved.source === "article" && resolved.byline) {
        payload.author = resolved.byline;
      }
    }

    if (currentType === "screenshot") {
      // On any screenshot-path failure we return an inline error instead
      // of calling showError: the popup stays in "main" state, the status
      // bar surfaces the message, and the user can press Save again
      // (or Retake) without losing the captured screenshot, the tags
      // they already picked, or the selected vault. Prior behaviour
      // toggled `state = "error"` which replaced the entire UI with
      // ErrorState and forced a reopen.
      if (!screenshotDataUrl) {
        setSaving(false);
        return { ok: false as const, error: "Screenshot not captured yet" };
      }
      if (!screenshotUploadId) {
        setSaving(false);
        return {
          ok: false as const,
          error: "Screenshot upload expired. Retake the screenshot and try again.",
        };
      }
      if (!uploadPortRef.current || !uploadTokenRef.current) {
        setSaving(false);
        return { ok: false as const, error: "Upload server not configured" };
      }
      try {
        const blob = await fetch(screenshotDataUrl).then((r) => r.blob());
        const ext = blob.type === "image/png" ? "png" : "jpg";
        const filename = `${(title || "screenshot").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60)}.${ext}`;
        const uploadResult = await uploadFile(
          uploadPortRef.current,
          uploadTokenRef.current,
          filename,
          screenshotUploadId,
        );
        if (uploadResult.ok && uploadResult.filename) {
          payload.pre_uploaded_file = uploadResult.filename;
        } else {
          setSaving(false);
          return {
            ok: false as const,
            error: `Upload failed: ${uploadResult.error ?? "unknown"}`,
          };
        }
      } catch (e) {
        setSaving(false);
        return {
          ok: false as const,
          error: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    } else if (currentType === "image") {
      // Image block requires a media source. Prefer the curated
      // imageToSave (content script picked it from the page's best
      // candidate), fall back to the og:image the preview already
      // shows, otherwise refuse the save to prevent a frontmatter
      // without `file:` / `image_url` — which previously created an
      // orphaned .md that never rendered in the feed.
      const imageUrl = metadata.imageToSave ?? metadata.image ?? null;
      if (!imageUrl) {
        setSaving(false);
        return {
          ok: false as const,
          error: "No image available — pick another type or capture a screenshot.",
        };
      }
      payload.image_url = imageUrl;
      payload.width = metadata.imageWidth ?? null;
      payload.height = metadata.imageHeight ?? null;
    } else if (metadata.image && (currentType === "link" || metadata.detectedType === "video")) {
      payload.image_url = metadata.image;
    }

    const result = await sendToNative(payload);
    setSaving(false);

    if (result.ok) {
      // Persist recent channels
      if (selectedTags.length > 0) {
        const updated = [
          ...selectedTags,
          ...recentTags.filter((t) => !selectedTags.includes(t)),
        ].slice(0, 10);
        setRecentTags(updated);
        chrome.storage.local.set({ recentChannels: updated });
      }
      return { ok: true as const };
    }
    return { ok: false as const, error: result.error ?? "Failed to save" };
  }, [
    metadata,
    articleData,
    currentType,
    title,
    selectedTags,
    recentTags,
    saving,
    screenshotDataUrl,
    screenshotUploadId,
  ]);

  const switchVault = useCallback(async (vaultPath: string) => {
    setSelectedVault(vaultPath);
    vaultRef.current = vaultPath;
    // Reload channels for new vault
    const chResult = await sendToNative({ action: "list_channels", vault_path: vaultPath });
    if (chResult.ok && chResult.channels) {
      setChannels(chResult.channels);
    }
    setSelectedTags([]);
  }, []);

  return {
    state,
    error,
    metadata,
    articleData,
    channels,
    selectedTags,
    recentTags,
    currentType,
    setCurrentType: handleTypeChange,
    screenshotDataUrl,
    retakeScreenshot,
    startCropMode,
    cropSupported,
    title,
    setTitle,
    saving,
    articleLoading,
    toggleTag,
    createChannel,
    save,
    knownVaults,
    selectedVault,
    switchVault,
  };
}

// ─── Twitter syndication API (direct fetch, no content script) ──────────

interface SyndicationMedia {
  type: string;
  media_url_https?: string;
  video_info?: { variants?: { content_type: string; bitrate?: number; url: string }[] };
}

async function fetchTweetBySyndicationApi(
  tweetId: string,
  authorHandle: string,
): Promise<ArticleData | null> {
  const resp = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`,
  );
  if (!resp.ok) return null;
  const data = await resp.json();

  const text: string = data.text ?? "";
  const media: string[] = [];

  for (const m of (data.mediaDetails ?? []) as SyndicationMedia[]) {
    if (m.type === "photo" && m.media_url_https) {
      media.push(m.media_url_https + "?name=large");
    } else if ((m.type === "video" || m.type === "animated_gif") && m.video_info?.variants) {
      const best = m.video_info.variants
        .filter((v) => v.content_type === "video/mp4" && v.bitrate != null)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (best[0]) media.push(best[0].url);
    }
  }

  const parts: string[] = [];
  if (text) parts.push(text);
  for (const src of media) {
    parts.push(`![](${src})`);
  }

  if (parts.length === 0) return null;

  const title = text.replace(/\n/g, " ").trim().slice(0, 80) || authorHandle;
  return {
    title,
    content: parts.join("\n\n"),
    byline: authorHandle,
    excerpt: text.slice(0, 200),
  };
}
