// Typed access to the standalone road (О1–О4).
//
// Writes and reads go through the background worker, which owns the granted
// directory handle via IndexedDB — one writer regardless of which surface
// (window popup or in-page overlay) asked. The one thing that must happen in a
// window is choosing the folder: the browser's directory picker needs a user
// gesture and a window, and in the overlay context the picker would bind the
// permission to the page's origin instead of the extension's, which is why it
// is refused there rather than attempted.

import "../../lib/standaloneVault.js";
import type { ChannelInfo, NativeResponse } from "./messaging";

export type StandaloneMode = "app" | "standalone" | "unconfigured";

export interface StandaloneStatus {
  configured: boolean;
  folderName?: string;
  bindingId?: string;
  permission?: "granted" | "prompt" | "denied";
  error?: string;
}

interface StandaloneVaultLib {
  storeDirectoryHandle: (handle: FileSystemDirectoryHandle) => Promise<void>;
  loadDirectoryHandle: (bindingId?: string) => Promise<FileSystemDirectoryHandle | null>;
  clearDirectoryHandle: () => Promise<void>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: "read" | "readwrite";
      id?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

function lib(): StandaloneVaultLib {
  return (globalThis as unknown as { MineStandaloneVault: StandaloneVaultLib })
    .MineStandaloneVault;
}

function toBackground<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "background", ...message }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message } as T);
      } else {
        resolve((response as T) ?? ({ ok: false, error: "No response" } as T));
      }
    });
  });
}

export function getStandaloneStatus(): Promise<StandaloneStatus> {
  return toBackground<StandaloneStatus>({ action: "standaloneStatus" });
}

export function standaloneSave(payload: Record<string, unknown>): Promise<NativeResponse> {
  return toBackground<NativeResponse>({ action: "standaloneSave", payload });
}

export function standaloneLookup(operationId: string, bindingId: string): Promise<NativeResponse> {
  return toBackground({ action: "standaloneLookup", operation_id: operationId, binding_id: bindingId });
}

export function openStandaloneSetup(bindingId?: string): Promise<{ ok: boolean; error?: string }> {
  return toBackground({ action: "openStandaloneSetup", binding_id: bindingId });
}

export function openDownloadPage(): Promise<{ ok: boolean; error?: string }> {
  return toBackground({ action: "openDownloadPage" });
}

export function notifyStandaloneFolderChanged(bindingId?: string): Promise<{ ok: boolean; error?: string }> {
  return toBackground({ action: bindingId ? "standaloneAccessRestored" : "standaloneFolderChanged", binding_id: bindingId });
}

/** Read a pending operation's original handle, never the currently selected one. */
export async function getBoundFolderStatus(bindingId: string): Promise<StandaloneStatus> {
  try {
    const handle = await lib().loadDirectoryHandle(bindingId);
    if (!handle) return { configured: false, error: "The original folder binding is unavailable. The save will not be moved to another folder." };
    const permission = await (handle as FileSystemDirectoryHandle & {
      queryPermission: (options: { mode: string }) => Promise<"granted" | "prompt" | "denied">;
    }).queryPermission({ mode: "readwrite" });
    return { configured: true, folderName: handle.name, bindingId, permission };
  } catch (cause) {
    return { configured: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function standaloneListChannels(): Promise<{
  ok: boolean;
  channels?: ChannelInfo[];
  error?: string;
}> {
  return toBackground({ action: "standaloneListChannels" });
}

export function standaloneCreateChannel(tag: string): Promise<{
  ok: boolean;
  tag?: string;
  error?: string;
}> {
  return toBackground({ action: "standaloneCreateChannel", tag });
}

/** Whether this surface can open the directory picker at all. */
export function canPickFolderHere(): boolean {
  return typeof chrome.tabs !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/**
 * Choose the folder clips are written into. Window context only; the granted
 * handle goes into IndexedDB where the background worker finds it.
 */
export async function chooseStandaloneFolder(): Promise<StandaloneStatus> {
  if (!canPickFolderHere()) {
    return { configured: false, error: "Folder can only be chosen from the clipper window" };
  }
  try {
    const handle = await window.showDirectoryPicker!({ mode: "readwrite", id: "mine-vault" });
    await lib().storeDirectoryHandle(handle);
    return getStandaloneStatus();
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") {
      return { configured: false };
    }
    return { configured: false, error: String((error as Error)?.message ?? error) };
  }
}

/** Re-ask for access to the already-chosen folder after the browser dropped it. */
export async function regrantStandaloneAccess(bindingId?: string): Promise<StandaloneStatus> {
  if (!canPickFolderHere()) {
    return { configured: false, error: "Restore folder access in the Mine extension window" };
  }
  try {
    const handle = await lib().loadDirectoryHandle(bindingId);
    if (!handle) return { configured: false, error: "No folder is selected. Choose a folder to continue." };
    const permission = await (
      handle as FileSystemDirectoryHandle & {
        requestPermission: (options: { mode: string }) => Promise<"granted" | "prompt" | "denied">;
      }
    ).requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      return { configured: true, folderName: handle.name, permission, error: "Write access was not granted. Allow access or choose another folder." };
    }
    return bindingId ? getBoundFolderStatus(bindingId) : getStandaloneStatus();
  } catch (error) {
    return { configured: false, error: error instanceof Error ? error.message : String(error) };
  }
}
