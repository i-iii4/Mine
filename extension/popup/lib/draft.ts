import type { ArticleData, PageMetadata } from "./messaging";

/** Everything needed to reconstruct the preview, including screenshot bytes. */
export interface ClipperDraftState {
  metadata: PageMetadata;
  articleData: ArticleData | null;
  title: string;
  selectedTags: string[];
  currentType: "content" | "link" | "image" | "video" | "screenshot";
  selectedVault: string | null;
  screenshotDataUrl: string | null;
  screenshotUploadId: string | null;
  executor: "native" | "browser" | null;
  bindingId: string | null;
}

/** An acknowledged draft edition survives extension context replacement. */
export interface DurableClipperDraft {
  schemaVersion: 1;
  revision: number;
  draftId: string;
  state: ClipperDraftState;
}

function request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "background", action, ...payload }, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!response?.ok) { reject(new Error(response?.error ?? "The draft could not be stored")); return; }
      resolve(response.draft);
    });
  });
}

function validateDraft(value: unknown): DurableClipperDraft | null {
  if (value === null) return null;
  const object = (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry));
  const nullableString = (entry: unknown) => entry === null || typeof entry === "string";
  if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)
    || typeof value.revision !== "number" || value.revision < 1 || typeof value.draftId !== "string" || !value.draftId
    || !object(value.state)) throw new Error("The saved draft format is unknown or damaged and has been preserved");
  const state = value.state;
  if (!object(state.metadata) || typeof state.metadata.url !== "string" || typeof state.metadata.title !== "string"
    || typeof state.metadata.selection !== "string" || typeof state.metadata.detectedType !== "string"
    || typeof state.title !== "string" || !Array.isArray(state.selectedTags) || !state.selectedTags.every(tag => typeof tag === "string")
    || !["content", "link", "image", "video", "screenshot"].includes(String(state.currentType))
    || !nullableString(state.selectedVault) || !nullableString(state.screenshotDataUrl) || !nullableString(state.screenshotUploadId)
    || !["native", "browser", null].includes(state.executor as string | null) || !nullableString(state.bindingId)
    || (state.articleData !== null && (!object(state.articleData) || typeof state.articleData.title !== "string"
      || typeof state.articleData.content !== "string" || (state.articleData.embeddedVideos !== undefined && !Array.isArray(state.articleData.embeddedVideos))))) {
    throw new Error("The saved draft content is damaged and has been preserved");
  }
  // Essential rendering fields and the schema have been validated above; extra
  // metadata and extraction fields remain opaque and are preserved unchanged.
  return value as unknown as DurableClipperDraft;
}

/** Read the last confirmed edition without modifying an unknown format. */
export async function readDraft(sourceUrl: string): Promise<DurableClipperDraft | null> {
  return validateDraft(await request<unknown>("draftRead", { sourceUrl }));
}

/** Confirm all state and attachment bytes before reporting a durable edition. */
export function writeDraft(sourceUrl: string, draft: DurableClipperDraft, expectedRevision: number): Promise<DurableClipperDraft> {
  return request("draftWrite", { sourceUrl, draft, expectedRevision });
}

/** Remove only the draft whose source commit has been confirmed. */
export function clearDraft(sourceUrl: string, draftId: string, expectedRevision: number): Promise<void> {
  return request("draftClear", { sourceUrl, draftId, expectedRevision });
}
