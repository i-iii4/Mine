// Versions of the interface, to compare while it is being reworked: version 1
// is the interface as it stood on 03.10.2026, version 2 is the one changed
// from then on. The version sits on the root as `data-ui-version`; styles
// answer the attribute, code reads `useUiVersion`. Every page applies the
// stored version at start and follows `settings-changed`.

import { useSyncExternalStore } from "react";

export type UiVersion = 1 | 2;

export const UI_VERSIONS: readonly UiVersion[] = [1, 2];

export const UI_VERSION_STORAGE_KEY = "mine.uiVersion";

/** The version being worked on, and the one a fresh install shows. */
export const DEFAULT_UI_VERSION: UiVersion = 2;

const ATTRIBUTE = "data-ui-version";

function parse(value: string | null | undefined): UiVersion {
  return value === "1" ? 1 : value === "2" ? 2 : DEFAULT_UI_VERSION;
}

export function getStoredUiVersion(): UiVersion {
  try {
    return parse(window.localStorage.getItem(UI_VERSION_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_VERSION;
  }
}

/** Store `version` and show it on this page. */
export function storeUiVersion(version: UiVersion): void {
  try {
    window.localStorage.setItem(UI_VERSION_STORAGE_KEY, String(version));
  } catch (error) {
    console.error("Could not store the interface version:", error);
  }
  applyUiVersion(version);
}

export function applyUiVersion(version: UiVersion): void {
  document.documentElement.setAttribute(ATTRIBUTE, String(version));
}

export function getUiVersion(): UiVersion {
  return parse(document.documentElement.getAttribute(ATTRIBUTE));
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTRIBUTE] });
  return () => observer.disconnect();
}

/** The version this page shows, kept current. */
export function useUiVersion(): UiVersion {
  return useSyncExternalStore(subscribe, getUiVersion, () => DEFAULT_UI_VERSION);
}
