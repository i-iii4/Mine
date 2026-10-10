// The clip of an open overlay, kept by background for its tab while the
// overlay is open, so that a new document in the same tab opens the overlay
// with the same clip (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р7;
// SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч12). It is not a draft: no address finds
// it, no other tab sees it, and it goes with the close, the Save, the tab,
// the extension's reload and the browser's restart.

import { createContext } from "react";
import type { ArticleData, PageMetadata } from "./messaging";
import type { ArticleExtractionState } from "./articleExtractionState";
import type { ClipType } from "../hooks/useClipperState";

export const OPEN_CLIP_VERSION = 1;

const CLIP_TYPES: readonly ClipType[] = ["content", "link", "image", "video", "screenshot"];
const EXTRACTION_STATES: readonly ArticleExtractionState[] = ["idle", "loading", "ready", "empty", "failed"];
const EXECUTORS = ["native", "browser"] as const;

/** Where the clip was going to be saved when it was written. */
export interface OpenClipDestination {
  executor: (typeof EXECUTORS)[number] | null;
  vaultPath: string | null;
  bindingId: string | null;
  /** The folder's name or the space's path, for the moved-clip notice. */
  label: string | null;
}

export interface OpenClipScreenshot {
  dataUrl: string;
  /** The background upload cache entry; it may be gone after a restart. */
  uploadId: string | null;
}

export interface OpenClip {
  version: typeof OPEN_CLIP_VERSION;
  /** The page the clip was opened on. A new launch on another address starts a new clip (Ч11). */
  pageUrl: string;
  metadata: PageMetadata;
  articleData: ArticleData | null;
  articleExtractionState: ArticleExtractionState;
  /** The post an X button brought, still to be assembled. */
  launchedArticle: ArticleData | null;
  /** The link of a Save link clip: its screenshot must show that page (В4.2). */
  linkTarget: string | null;
  title: string;
  selectedTags: string[];
  currentType: ClipType;
  destination: OpenClipDestination;
  screenshot: OpenClipScreenshot | null;
  /** Whether the person changed the clip (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч11). */
  edited: boolean;
}

/** What the editor sends: the screenshot only when it changed. Without the
 *  field, background keeps the screenshot it has. */
export type OpenClipWrite = Omit<OpenClip, "screenshot"> & { screenshot?: OpenClipScreenshot | null };

/** The clip an overlay opens with after its page changed; `null` for a new clip. */
export const OpenClipContext = createContext<OpenClip | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isMetadata(value: unknown): value is PageMetadata {
  return isRecord(value) && typeof value.url === "string" && typeof value.title === "string"
    && typeof value.selection === "string" && typeof value.detectedType === "string";
}

function isArticle(value: unknown): value is ArticleData {
  return isRecord(value) && typeof value.content === "string" && typeof value.title === "string";
}

function parseDestination(value: unknown): OpenClipDestination | null {
  if (!isRecord(value)) return null;
  const executor = value.executor === null ? null
    : EXECUTORS.find((candidate) => candidate === value.executor);
  const vaultPath = stringOrNull(value.vaultPath);
  const bindingId = stringOrNull(value.bindingId);
  const label = stringOrNull(value.label);
  if (executor === undefined || vaultPath === undefined || bindingId === undefined || label === undefined) return null;
  return { executor, vaultPath, bindingId, label };
}

function parseScreenshot(value: unknown): OpenClipScreenshot | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.dataUrl !== "string" || !value.dataUrl.startsWith("data:")) return undefined;
  const uploadId = stringOrNull(value.uploadId);
  return uploadId === undefined ? undefined : { dataUrl: value.dataUrl, uploadId };
}

/// The clip background handed back, or `null` when it is not one this
/// version can open: the overlay then opens a new clip as before.
export function parseOpenClip(value: unknown): OpenClip | null {
  if (!isRecord(value) || value.version !== OPEN_CLIP_VERSION) return null;
  const currentType = CLIP_TYPES.find((type) => type === value.currentType);
  const articleExtractionState = EXTRACTION_STATES.find((state) => state === value.articleExtractionState);
  const destination = parseDestination(value.destination);
  const screenshot = parseScreenshot(value.screenshot ?? null);
  const linkTarget = stringOrNull(value.linkTarget ?? null);
  const { pageUrl, metadata, title, edited, selectedTags } = value;
  const articleData = value.articleData === null ? null : isArticle(value.articleData) ? value.articleData : undefined;
  const launchedArticle = value.launchedArticle === null ? null
    : isArticle(value.launchedArticle) ? value.launchedArticle : undefined;
  const tags = Array.isArray(selectedTags) && selectedTags.every((tag): tag is string => typeof tag === "string")
    ? selectedTags : undefined;
  if (typeof pageUrl !== "string" || !isMetadata(metadata) || !currentType || !articleExtractionState
    || !destination || screenshot === undefined || linkTarget === undefined || typeof title !== "string"
    || typeof edited !== "boolean" || !tags || articleData === undefined || launchedArticle === undefined) {
    return null;
  }
  return {
    version: OPEN_CLIP_VERSION,
    pageUrl,
    metadata,
    articleData,
    articleExtractionState,
    launchedArticle,
    linkTarget,
    title,
    selectedTags: tags,
    currentType,
    destination,
    screenshot,
    edited,
  };
}

function tellBackground(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage({ target: "background", ...message }, () => {
      // No answer is needed; reading the error keeps the browser quiet.
      void chrome.runtime.lastError;
    });
  } catch {
    // The extension context is gone: there is no background to keep the clip.
  }
}

/// Hand the clip of this open overlay to background for its tab.
export function writeOpenClip(clip: OpenClipWrite): void {
  tellBackground({ action: "openClipWrite", clip });
}

/// The overlay of this tab closed or saved: its clip goes.
export function clearOpenClip(): void {
  tellBackground({ action: "openClipClear" });
}
