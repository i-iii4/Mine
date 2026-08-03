// Action-button presentation — the bottom bar's button style.
//
// Two variants, switchable from Appearance:
//
// - `pill` (default): hotkey and label as two filled pills inside one frame.
// - `standard`: the design-system Button holding the hotkey, with the action
//   name as plain text beside it.
//
// Modelled on designMode: the root data attribute is the single switch, and
// components subscribe through the hook rather than receiving a prop, so any
// ActionButton anywhere follows the setting without threading it through.

import { useSyncExternalStore } from "react";

export type ActionButtonStyle = "pill" | "standard";

export const ACTION_BUTTON_STYLE_STORAGE_KEY = "mine.actionButtonStyle";

export function getStoredActionButtonStyle(): ActionButtonStyle {
  if (typeof window === "undefined") return "pill";
  return window.localStorage.getItem(ACTION_BUTTON_STYLE_STORAGE_KEY) === "standard"
    ? "standard"
    : "pill";
}

export function applyActionButtonStyle(style: ActionButtonStyle) {
  localStorage.setItem(ACTION_BUTTON_STYLE_STORAGE_KEY, style);
  const root = document.documentElement;
  if (style === "standard") {
    root.setAttribute("data-action-button-style", "standard");
  } else {
    root.removeAttribute("data-action-button-style");
  }
}

function readStyle(): ActionButtonStyle {
  return document.documentElement.getAttribute("data-action-button-style") === "standard"
    ? "standard"
    : "pill";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-action-button-style"],
  });
  return () => observer.disconnect();
}

export function useActionButtonStyle(): ActionButtonStyle {
  return useSyncExternalStore(subscribe, readStyle, () => "pill");
}
