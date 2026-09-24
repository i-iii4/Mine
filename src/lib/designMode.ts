// Alt 1 is the only active layout. The retained storage key is normalized
// at startup so installations using retired variants receive the same geometry.

import { useSyncExternalStore } from "react";

export type DesignMode = "default" | "alt" | "alt2";

export const DESIGN_STORAGE_KEY = "mine.design";

export function getStoredDesignMode(): DesignMode {
  // Migration: "alt" briefly shipped as a fourth theme value.
  if (localStorage.getItem("theme") === "alt") {
    localStorage.setItem("theme", "system");
    localStorage.setItem(DESIGN_STORAGE_KEY, "alt");
  }
  return "alt";
}

export function applyDesign(_mode: DesignMode) {
  localStorage.setItem(DESIGN_STORAGE_KEY, "alt");
  document.documentElement.setAttribute("data-design", "alt");
}

export function getDesignMode(): DesignMode {
  return "alt";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-design"],
  });
  return () => observer.disconnect();
}

export function useDesignMode(): DesignMode {
  return useSyncExternalStore(subscribe, getDesignMode, () => "alt");
}
