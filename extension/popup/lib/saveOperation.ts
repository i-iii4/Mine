import { sendToNative, type NativeRequest, type NativeResponse } from "./messaging";
import { standaloneLookup, standaloneSave } from "./standalone";

export interface PinnedSaveOperation {
  id: string;
  draftId?: string;
  sourceUrl?: string;
  folderLabel?: string;
  executor: "native" | "browser";
  bindingId: string;
  vaultPath: string | null;
  payload: NativeRequest | null;
  attempted: boolean;
}

const PENDING_PREFIX = "minePendingSaveOperation:";

export async function persistPendingSave(operation: PinnedSaveOperation): Promise<void> {
  // A restart between persistence and dispatch must be treated as unknown.
  await chrome.storage.local.set({ [PENDING_PREFIX + operation.id]: { ...operation, attempted: true } });
}

export async function clearPendingSave(operation: PinnedSaveOperation): Promise<void> {
  await chrome.storage.local.remove(PENDING_PREFIX + operation.id);
}

export async function findPendingSave(url: string): Promise<PinnedSaveOperation | null> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX) || !value || typeof value !== "object") continue;
    const operation = value as Partial<PinnedSaveOperation>;
    if (typeof operation.id !== "string" || typeof operation.bindingId !== "string"
      || (operation.executor !== "native" && operation.executor !== "browser")
      || (operation.vaultPath !== null && typeof operation.vaultPath !== "string")) continue;
    const payload = operation.payload && typeof operation.payload === "object" && operation.payload.action === "save_block" ? operation.payload : null;
    const sourceUrl = typeof operation.sourceUrl === "string" ? operation.sourceUrl : typeof payload?.url === "string" ? payload.url : undefined;
    // A damaged payload remains discoverable and lookup-only; it is not proof
    // that the source operation never happened. Older records use payload.url.
    if (sourceUrl && sourceUrl !== url) continue;
    return { id: operation.id, executor: operation.executor, bindingId: operation.bindingId,
      vaultPath: operation.vaultPath, payload, sourceUrl, draftId: operation.draftId,
      folderLabel: typeof operation.folderLabel === "string" ? operation.folderLabel : undefined, attempted: true };
  }
  return null;
}

/** A retry checks the original journal; it never allocates another save. */
export async function executePinnedSave(operation: PinnedSaveOperation): Promise<NativeResponse> {
  if (operation.attempted) {
    const known = await lookupPinnedSave(operation);
    if (known.resumable !== true || known.outcome !== "not_committed" || !operation.payload) return known;
    // Only the executor's durable pre-effect record can authorize resume.
    const request = { ...operation.payload, operation_id: operation.id, binding_id: operation.bindingId,
      executor_id: operation.executor, vault_path: operation.vaultPath, mode: "resume", operation_mode: "resume" };
    return operation.executor === "browser" ? standaloneSave(request) : sendToNative(request);
  }
  if (!operation.payload) return { ok: false, outcome: "unknown", error: "The original draft is unavailable; only its save outcome can be checked." };
  operation.attempted = true;
  const request = {
    ...operation.payload,
    operation_id: operation.id,
    binding_id: operation.bindingId,
    executor_id: operation.executor,
    vault_path: operation.vaultPath,
    operation_mode: "start",
    mode: "start",
  };
  const result = operation.executor === "browser"
    ? await standaloneSave(request)
    : await sendToNative(request);
  if (result.ok || result.outcome === "committed") return result;
  // A transport error cannot tell whether the source commit happened.
  // Explicit domain errors stay visible; unknown results get one read-only probe.
  if (result.outcome === "unknown" || !result.outcome) {
    return lookupPinnedSave(operation);
  }
  return result;
}

export function lookupPinnedSave(operation: PinnedSaveOperation): Promise<NativeResponse> {
  return operation.executor === "browser"
    ? standaloneLookup(operation.id, operation.bindingId)
    : sendToNative({
      action: "get_save_operation", operation_id: operation.id,
      binding_id: operation.bindingId, executor_id: operation.executor,
      vault_path: operation.vaultPath,
    });
}
