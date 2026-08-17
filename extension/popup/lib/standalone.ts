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
  permission?: "granted" | "prompt" | "denied";
  error?: string;
}

interface StandaloneVaultLib {
  storeDirectoryHandle: (handle: FileSystemDirectoryHandle) => Promise<void>;
  loadDirectoryHandle: () => Promise<FileSystemDirectoryHandle | null>;
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
    return { configured: true, folderName: handle.name, permission: "granted" };
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") {
      return { configured: false };
    }
    return { configured: false, error: String((error as Error)?.message ?? error) };
  }
}

/** Re-ask for access to the already-chosen folder after the browser dropped it. */
export async function regrantStandaloneAccess(): Promise<StandaloneStatus> {
  const handle = await lib().loadDirectoryHandle();
  if (!handle) return { configured: false };
  const permission = await (
    handle as unknown as {
      requestPermission: (options: { mode: string }) => Promise<"granted" | "prompt" | "denied">;
    }
  ).requestPermission({ mode: "readwrite" });
  return { configured: true, folderName: handle.name, permission };
}
