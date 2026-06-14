// Design variant — the layout axis, orthogonal to the color theme. The root
// data-design attribute is the single switch: CSS reads [data-design="alt"]
// directly, JS-computed layout (the masonry grid) subscribes via
// useDesignMode. Persisted separately from the theme so light/dark/system
// combine freely with either design.

import { useSyncExternalStore } from "react";

export type DesignMode = "default" | "alt";

export const DESIGN_STORAGE_KEY = "mine.design";

export function getStoredDesignMode(): DesignMode {
  // Migration: "alt" briefly shipped as a fourth theme value.
  if (localStorage.getItem("theme") === "alt") {
    localStorage.setItem("theme", "system");
    localStorage.setItem(DESIGN_STORAGE_KEY, "alt");
  }
  return localStorage.getItem(DESIGN_STORAGE_KEY) === "alt" ? "alt" : "default";
}

export function applyDesign(mode: DesignMode) {
  localStorage.setItem(DESIGN_STORAGE_KEY, mode);
  const root = document.documentElement;
  if (mode === "alt") {
    root.setAttribute("data-design", "alt");
  } else {
    root.removeAttribute("data-design");
  }
}

export function getDesignMode(): DesignMode {
  return document.documentElement.getAttribute("data-design") === "alt"
    ? "alt"
    : "default";
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
