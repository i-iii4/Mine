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
    const alt = match[1].trim();
    if (!alt) continue;
    if (seen.has(alt)) {
      // Remove this duplicate line and its caption
      const lines = result.split("\n");
      const idx = lines.findIndex((l) => l.includes(match[0]));
      if (idx >= 0) {
        lines.splice(idx, 1);
        if (idx < lines.length && lines[idx].trim() === "") lines.splice(idx, 1);
        if (idx < lines.length && lines[idx].trim() === alt) {
          lines.splice(idx, 1);
          if (idx < lines.length && lines[idx].trim() === "") lines.splice(idx, 1);
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
  type NativeRequest,
  type ChannelInfo,
  type PageMetadata,
  type ArticleData,
  type ContextMenuData,
} from "../lib/messaging";

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
  const [cropSupported, setCropSupported] = useState<boolean>(false);
  const uploadPortRef = useRef<number | null>(null);
  const uploadTokenRef = useRef<string | null>(null);

  const tabIdRef = useRef<number | null>(null);
  const vaultRef = useRef<string | null>(null);

  const captureScreenshot = useCallback(() => {
    chrome.tabs.captureVisibleTab(
      null as unknown as number,
      { format: "jpeg", quality: 85 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          showError(`Screenshot failed: ${chrome.runtime.lastError.message}`);
          return;
        }
        if (dataUrl) setScreenshotDataUrl(dataUrl);
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

  const startCropMode = useCallback(async () => {
    if (!cropSupported || tabIdRef.current === null) return;

    // Persist entire popup state so we can rehydrate after the popup reopens
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
      },
    });

    // Wait for background to confirm the overlay was successfully mounted in the
    // content script before closing the popup. If we close too early, the
    // chrome.tabs.sendMessage roundtrip inside background loses its sender
    // context and the overlay never appears.
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
      // Overlay didn't start — common causes: stale content script after
      // extension reload, or chrome:// page slipping past cropSupported check.
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
  ]);

  // --- Init ---

  useEffect(() => {
    init();
  }, []);

  async function init() {
    try {
      chrome.action.setBadgeText({ text: "" });

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
        };
        const result = cropData.cropResult as { status: "done" | "cancelled"; dataUrl?: string };

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
        } else {
          // Cancelled — keep previous (un-cropped) screenshot
          setScreenshotDataUrl(pending.screenshotDataUrl);
        }

        // Re-check crop capability for the same tab
        const tabUrl = pending.tabId !== null
          ? (await chrome.tabs.get(pending.tabId).catch(() => null))?.url ?? null
          : null;
        applyCropCapability(tabUrl);

        setState("main");
        return;
      }

      const ctxData = await getContextMenuData();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showError("Cannot access current tab");
        return;
      }
      tabIdRef.current = tab.id;
      applyCropCapability(tab.url ?? null);

      const [meta, article] = await Promise.all([
        extractMetadata(tab.id),
        extractArticle(tab.id),
      ]);

      // Apply tab fallbacks
      if (!meta.url && tab.url) meta.url = tab.url;
      if (!meta.title && tab.title) meta.title = tab.title;

      // Apply context menu overrides
      if (ctxData) {
        await applyContextMenu(ctxData, meta, tab.id);
      }

      // Deduplicate images with identical alt text (e.g. OG hero + same image in body)
      if (article.content) {
        article.content = deduplicateImages(article.content);
      }

      setMetadata(meta);
      setArticleData(article);
      setTitle(meta.title ?? "");

      // Map detected type
      let detected: ClipType = "link";
      const dt = meta.detectedType;
      if (dt === "article" || dt === "selection" || dt === "content") {
        detected = "content";
      } else if (dt === "image") {
        detected = "image";
      } else if (dt === "video") {
        detected = "content";
      }
      setCurrentType(detected);

      setState("main");

      // Background: fetch async article for video (YouTube transcript) and Twitter (syndication API)
      const needsAsync = meta.detectedType === "video"
        || (meta.detectedType === "article" && !article.content);
      if (needsAsync && tab.id) {
        setArticleLoading(true);
        extractArticleAsync(tab.id).then((asyncArticle) => {
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
        meta.detectedType = "link";
        if (ctx.linkUrl) meta.url = ctx.linkUrl;
        break;
      case "save-page":
        break;
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
      if (metadata.detectedType === "video") {
        payload.body = articleData?.content || "";
      } else if (metadata.selection?.length > 0) {
        payload.body = metadata.selection;
      } else if (articleData?.content) {
        payload.body = articleData.content;
        if (articleData.byline) payload.author = articleData.byline;
      }
    }

    if (currentType === "screenshot") {
      if (!screenshotDataUrl) {
        setSaving(false);
        showError("Screenshot not captured yet");
        return;
      }
      if (!uploadPortRef.current || !uploadTokenRef.current) {
        setSaving(false);
        showError("Upload server not configured");
        return;
      }
      try {
        const blob = await fetch(screenshotDataUrl).then((r) => r.blob());
        const ext = blob.type === "image/png" ? "png" : "jpg";
        const filename = `${(title || "screenshot").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60)}.${ext}`;
        const uploadResult = await uploadFile(uploadPortRef.current, uploadTokenRef.current, filename, blob);
        if (uploadResult.ok && uploadResult.filename) {
          payload.pre_uploaded_file = uploadResult.filename;
        } else {
          setSaving(false);
          showError(`Upload failed: ${uploadResult.error ?? "unknown"}`);
          return;
        }
      } catch (e) {
        setSaving(false);
        showError(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else if (currentType === "image" && metadata.imageToSave) {
      payload.image_url = metadata.imageToSave;
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
  }, [metadata, articleData, currentType, title, selectedTags, recentTags, saving, screenshotDataUrl]);

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
