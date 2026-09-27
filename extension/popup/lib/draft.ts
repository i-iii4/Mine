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
  screenshotUploadId?: string | null;
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

export interface DraftAttachment {
  draft: DurableClipperDraft | null;
  draftId: string;
  generation: number;
  sequence?: number;
}

export interface DraftOwnership {
  ownerId: string;
  generation: number;
  mutationId: string;
  sequence?: number;
}

export class DraftStorageError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

const DRAFT_RESPONSE_TIMEOUT_MS = 10_000;

function request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new DraftStorageError("The draft response was not confirmed. Retry to check its outcome", "draft_transport")), DRAFT_RESPONSE_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ target: "background", action, ...payload }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { reject(new DraftStorageError(chrome.runtime.lastError.message ?? "The draft connection stopped", "draft_transport")); return; }
        if (!response?.ok) { reject(new DraftStorageError(response?.error ?? "The draft could not be stored", response?.code ?? "draft_storage_failed")); return; }
        resolve(response.draft);
      });
    } catch (cause) {
      clearTimeout(timeout);
      reject(new DraftStorageError(cause instanceof Error ? cause.message : String(cause), "draft_transport"));
    }
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
    || !nullableString(state.selectedVault) || !nullableString(state.screenshotDataUrl)
    || (state.screenshotUploadId !== undefined && !nullableString(state.screenshotUploadId))
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

/** Restore and atomically take ownership before this editor can mutate a draft. */
export async function attachDraft(sourceUrl: string, options: { ownerId: string; captureId: string; newCapture: boolean }, sourceTabId: number | null): Promise<DraftAttachment> {
  const attached = await request<DraftAttachment>("draftAttach", { sourceUrl, options, sourceTabId });
  if (!attached || typeof attached.draftId !== "string" || !Number.isSafeInteger(attached.generation) || attached.generation < 1
    || (attached.sequence !== undefined && (!Number.isSafeInteger(attached.sequence) || attached.sequence < 0))) {
    throw new DraftStorageError("The draft ownership response is invalid", "invalid_draft");
  }
  return { ...attached, draft: validateDraft(attached.draft) };
}

/** A repeated mutation confirms the same edition after an interrupted reply. */
export function writeOwnedDraft(sourceUrl: string, draft: DurableClipperDraft, expectedRevision: number, ownership: DraftOwnership): Promise<DurableClipperDraft> {
  return request("draftWriteOwned", { sourceUrl, draft, expectedRevision, ownership });
}

/** Confirm all state and attachment bytes before reporting a durable edition. */
export function writeDraft(sourceUrl: string, draft: DurableClipperDraft, expectedRevision: number): Promise<DurableClipperDraft> {
  return request("draftWrite", { sourceUrl, draft, expectedRevision });
}

/** Remove only the draft whose source commit has been confirmed. */
export function clearDraft(sourceUrl: string, draftId: string, expectedRevision: number): Promise<void> {
  return request("draftClear", { sourceUrl, draftId, expectedRevision });
}

/** A legacy save completion cannot remove a draft owned by a reopened editor. */
export function clearOwnedDraft(sourceUrl: string, draftId: string, expectedRevision: number, ownership: Pick<DraftOwnership, "ownerId" | "generation">): Promise<void> {
  return request("draftClearOwned", { sourceUrl, draftId, expectedRevision, ownership });
}
