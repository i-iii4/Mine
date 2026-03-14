import { useState, useEffect, useCallback, useRef } from "react";
import {
  sendToNative,
  getContextMenuData,
  extractMetadata,
  extractArticle,
  getImageInfo,
  type NativeRequest,
  type ChannelInfo,
  type PageMetadata,
  type ArticleData,
  type ContextMenuData,
} from "../lib/messaging";

export type ClipType = "content" | "link" | "image" | "video";
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

  const tabIdRef = useRef<number | null>(null);

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
        showError(status.error ?? "Cannot connect to Local Arena");
        return;
      }

      const chResult = await sendToNative({ action: "list_channels" });
      if (chResult.ok && chResult.channels) {
        setChannels(chResult.channels);
      }

      const ctxData = await getContextMenuData();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showError("Cannot access current tab");
        return;
      }
      tabIdRef.current = tab.id;

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
        detected = "link";
      }
      setCurrentType(detected);

      setState("main");
    } catch (e) {
      showError("Failed to initialize: " + (e instanceof Error ? e.message : String(e)));
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
    await sendToNative({ action: "create_channel", tag: name, title: name });
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
    } else if (currentType === "image") blockType = "image";
    else blockType = currentType;

    const payload: NativeRequest = {
      action: "save_block",
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
        // Body empty for now — transcript will be added later via Defuddle
        payload.body = "";
      } else if (metadata.selection?.length > 0) {
        payload.body = metadata.selection;
      } else if (articleData?.content) {
        payload.body = articleData.content;
        if (articleData.byline) payload.author = articleData.byline;
      }
    }

    if (currentType === "image" && metadata.imageToSave) {
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
  }, [metadata, articleData, currentType, title, selectedTags, recentTags, saving]);

  return {
    state,
    error,
    metadata,
    articleData,
    channels,
    selectedTags,
    recentTags,
    currentType,
    setCurrentType,
    title,
    setTitle,
    saving,
    toggleTag,
    createChannel,
    save,
  };
}
