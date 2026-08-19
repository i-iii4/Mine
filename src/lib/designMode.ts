// Design variant — the layout axis, orthogonal to the color theme. The root
// data-design attribute is the single switch: CSS reads [data-design="alt"]
// directly, JS-computed layout (the masonry grid) subscribes via
// useDesignMode. Persisted separately from the theme so light/dark/system
// combine freely with either design.

import { useSyncExternalStore } from "react";

/// Two alternative layouts live beside the primary one. Alt 2 starts as an
/// exact copy of Alt 1 — a place to try changes without disturbing a variant
/// that is already in use.
export type DesignMode = "default" | "alt" | "alt2";

export const DESIGN_STORAGE_KEY = "mine.design";

export function getStoredDesignMode(): DesignMode {
  // Migration: "alt" briefly shipped as a fourth theme value.
  if (localStorage.getItem("theme") === "alt") {
    localStorage.setItem("theme", "system");
    localStorage.setItem(DESIGN_STORAGE_KEY, "alt");
  }
  const stored = localStorage.getItem(DESIGN_STORAGE_KEY);
  return stored === "alt" || stored === "alt2" ? stored : "default";
}

export function applyDesign(mode: DesignMode) {
  localStorage.setItem(DESIGN_STORAGE_KEY, mode);
  const root = document.documentElement;
  if (mode === "default") {
    root.removeAttribute("data-design");
  } else {
    root.setAttribute("data-design", mode);
  }
}

export function getDesignMode(): DesignMode {
  const attr = document.documentElement.getAttribute("data-design");
  return attr === "alt" || attr === "alt2" ? attr : "default";
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
  return useSyncExternalStore(subscribe, getDesignMode, () => "default");
}
