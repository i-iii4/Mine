import { sendToNative, type NativeRequest, type NativeResponse } from "./messaging";
import { standaloneLookup, standaloneSave } from "./standalone";
import "../../lib/storedValue.js";

declare global {
  var MineStoredValue: Readonly<{ same(left: unknown, right: unknown): boolean }>;
}

export interface PinnedSaveOperation {
  schemaVersion?: 1;
  id: string;
  terminalResult?: NativeResponse;
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
  const key = PENDING_PREFIX + operation.id;
  const record = { ...operation, schemaVersion: 1, attempted: true };
  const previous = await chrome.storage.local.get(key);
  if (previous[key] !== undefined) {
    // This read confirms a previously interrupted persistence attempt. It does
    // not establish whether dispatch happened; restored operations stay attempted.
    if (!operation.terminalResult && MineStoredValue.same(previous[key], record)) return;
    throw new Error("An operation with this identity is already stored and has been preserved");
  }
  await chrome.storage.local.set({ [key]: record });
  const confirmed = await chrome.storage.local.get(key);
  if (!MineStoredValue.same(confirmed[key], record)) {
    throw new Error("The save operation could not be confirmed in durable storage; no save was dispatched");
  }
}

export async function clearPendingSave(operation: PinnedSaveOperation): Promise<void> {
  const key = PENDING_PREFIX + operation.id;
  const stored = await chrome.storage.local.get(key);
  if (stored[key] !== undefined) validateStoredOperation(stored[key], operation);
  await chrome.storage.local.remove(key);
}

function validateStoredOperation(value: unknown, operation: PinnedSaveOperation): void {
  if (!value || typeof value !== "object" || !("id" in value) || value.id !== operation.id
    || !("bindingId" in value) || value.bindingId !== operation.bindingId
    || !("executor" in value) || value.executor !== operation.executor
    || ("schemaVersion" in value && value.schemaVersion !== 1)) {
    throw new Error("The pending save changed or has an unknown format and has been preserved");
  }
}

/** Keep an acknowledged source commit until its record is removed: a record
 *  that outlives a failed removal is settled, not unresolved. */
export async function persistSaveReceipt(operation: PinnedSaveOperation, result: NativeResponse): Promise<void> {
  if (!result.ok && result.outcome !== "committed") throw new Error("An unconfirmed save cannot have a committed receipt");
  const key = PENDING_PREFIX + operation.id;
  const stored = await chrome.storage.local.get(key);
  if (stored[key] === undefined) throw new Error("The original pending operation is missing; its committed result remains in the executor journal");
  validateStoredOperation(stored[key], operation);
  const record = { ...operation, schemaVersion: 1, attempted: true, terminalResult: result };
  await chrome.storage.local.set({ [key]: record });
  const confirmed = await chrome.storage.local.get(key);
  if (!MineStoredValue.same(confirmed[key], record)) throw new Error("The committed save receipt could not be confirmed");
  operation.terminalResult = result;
}

/** Whether a stored record carries a committed result: nothing about it is
 *  left to check (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч4). */
function isSettled(operation: Partial<PinnedSaveOperation>): boolean {
  return operation.terminalResult?.ok === true || operation.terminalResult?.outcome === "committed";
}

/** Remove every record whose save is committed. A record in an unknown
 *  format is preserved. */
export async function clearCommittedSaves(): Promise<void> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(null);
  const settled = Object.entries(stored)
    .filter(([key, value]) => key.startsWith(PENDING_PREFIX) && value !== null && typeof value === "object"
      && (!("schemaVersion" in value) || value.schemaVersion === 1)
      && isSettled(value as Partial<PinnedSaveOperation>))
    .map(([key]) => key);
  if (settled.length > 0) await chrome.storage.local.remove(settled);
}

/** The unresolved save of this page, if any. A committed record is not one:
 *  it never blocks Save or asks for a check. */
export async function findPendingSave(url: string): Promise<PinnedSaveOperation | null> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_PREFIX) || !value || typeof value !== "object") continue;
    const operation = value as Partial<PinnedSaveOperation>;
    const payload = operation.payload && typeof operation.payload === "object" && operation.payload.action === "save_block" ? operation.payload : null;
    const sourceUrl = typeof operation.sourceUrl === "string" ? operation.sourceUrl : typeof payload?.url === "string" ? payload.url : undefined;
    // The source envelope scopes recovery before interpreting the versioned
    // payload. Preserve foreign records without blocking an unrelated page.
    // Missing source identity remains uncertain and must not authorize a retry.
    if (sourceUrl && sourceUrl !== url) continue;
    if ("schemaVersion" in operation && operation.schemaVersion !== 1) {
      throw new Error("An unknown pending save format has been preserved. Restore a compatible Mine version before saving");
    }
    if (typeof operation.id !== "string" || typeof operation.bindingId !== "string"
      || (operation.executor !== "native" && operation.executor !== "browser")
      || (operation.vaultPath !== null && typeof operation.vaultPath !== "string")) continue;
    if (isSettled(operation)) continue;
    // A damaged payload remains discoverable and lookup-only; it is not proof
    // that the source operation never happened. Older records use payload.url
    // and may carry draftId and draftRevision, which are no longer read.
    return { id: operation.id, executor: operation.executor, bindingId: operation.bindingId,
      vaultPath: operation.vaultPath, payload, sourceUrl,
      folderLabel: typeof operation.folderLabel === "string" ? operation.folderLabel : undefined, attempted: true };
  }
  return null;
}

/** A retry checks the original journal; it never allocates another save. */
export async function executePinnedSave(operation: PinnedSaveOperation): Promise<NativeResponse> {
  if (operation.terminalResult?.ok || operation.terminalResult?.outcome === "committed") return operation.terminalResult;
  if (operation.attempted) {
    const known = await lookupPinnedSave(operation);
    if (known.resumable !== true || known.outcome !== "not_committed" || !operation.payload) return known;
    // Only the executor's durable pre-effect record can authorize resume.
    const request = { ...operation.payload, operation_id: operation.id, binding_id: operation.bindingId,
      executor_id: operation.executor, vault_path: operation.vaultPath, mode: "resume", operation_mode: "resume" };
    return operation.executor === "browser" ? standaloneSave(request) : sendToNative(request);
  }
  if (!operation.payload) return { ok: false, outcome: "unknown", error: "The original clip is unavailable; only its save outcome can be checked." };
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
