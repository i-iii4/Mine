// Button styles per window: a dev tool for a choice the user is still making,
// not a design decision. A window draws its buttons with depth in one of
// three styles (src/styles/buttons.css): macOS, the default, Retro (the
// retro edges of /__button-depth, variant 1) or Linear (its Linear variant);
// root attribute `data-buttons="retro"` or `"linear"`, absent for macOS.
//
// A window's tab bar owns its style: it stores it by window id (windows.json
// restores windows with their ids, SPEC_TABS.md), applies it to itself and
// sends it to each of its tab pages, again whenever its tabs change, so a tab
// dragged in takes the window's style. A tab page applies what its bar sends
// and learns its window from it; ⌃⌥B in a page (macOS, Retro, Linear in turn)
// changes the page at once and asks its bar to spread the change. The
// settings window and a new window draw macOS.
//
// Removing the tool is this module, the Retro and Linear rules of
// buttons.css, the logo menu's Buttons item, the `flip-buttons` command and
// ButtonStyleNotice.

import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listenPage } from "./pageEvents";

export type ButtonStyle = "macos" | "retro" | "linear";

/** The styles in menu order, with their menu labels. */
export const BUTTON_STYLES: readonly { value: ButtonStyle; label: string }[] = [
  { value: "macos", label: "macOS" },
  { value: "retro", label: "Retro" },
  { value: "linear", label: "Linear" },
];

/** What a window draws before it chooses. */
export const DEFAULT_BUTTON_STYLE: ButtonStyle = "macos";

const isButtonStyle = (value: unknown): value is ButtonStyle => BUTTON_STYLES.some((style) => style.value === value);

/** Windows' button styles by window id. */
export type WindowButtonStyles = Readonly<Record<string, ButtonStyle>>;

/** Each window's entry is `{ "buttons": style }`. The key keeps the name it
 *  was first stored under, so windows keep their style. */
export const WINDOW_BUTTON_STYLES_STORAGE_KEY = "mine.devPalette.windows";

/** Bar → its tab pages: the window's style, and whether the page announces
 *  it (the visible one, when the switch was made in this window). */
export const WINDOW_BUTTON_STYLE_EVENT = "dev-buttons-window";
/** Tab page → its bar: the page stepped the window's style. */
export const WINDOW_BUTTON_STYLE_SET_EVENT = "dev-buttons-set";
/** Within a page: show the switch notice. */
export const BUTTON_STYLE_NOTICE_EVENT = "mine:dev-buttons-notice";

export interface WindowButtonStylePayload {
  window: string;
  style: ButtonStyle;
  notice: boolean;
}

export interface WindowButtonStyleSetPayload {
  window: string;
  style: ButtonStyle;
}

export function parseWindowButtonStyles(raw: string | null): WindowButtonStyles {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const styles: Record<string, ButtonStyle> = {};
    for (const [window, entry] of Object.entries(parsed)) {
      const style: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "buttons") : undefined;
      if (isButtonStyle(style)) styles[window] = style;
    }
    return styles;
  } catch {
    return {};
  }
}

/** The stored form of `styles`. */
export function serializeWindowButtonStyles(styles: WindowButtonStyles): string {
  return JSON.stringify(Object.fromEntries(Object.entries(styles).map(([window, style]) => [window, { buttons: style }])));
}

export function buttonStyleOfWindow(styles: WindowButtonStyles, window: string | null): ButtonStyle {
  return (window === null ? undefined : styles[window]) ?? DEFAULT_BUTTON_STYLE;
}

export function withWindowButtonStyle(styles: WindowButtonStyles, window: string, style: ButtonStyle): WindowButtonStyles {
  return { ...styles, [window]: style };
}

/** The next style in menu order, round. */
export function nextButtonStyle(style: ButtonStyle): ButtonStyle {
  const index = BUTTON_STYLES.findIndex((entry) => entry.value === style);
  return BUTTON_STYLES[(index + 1) % BUTTON_STYLES.length]?.value ?? DEFAULT_BUTTON_STYLE;
}

/** «Buttons: Retro». */
export function buttonStyleNoticeTitle(style: ButtonStyle): string {
  return `Buttons: ${BUTTON_STYLES.find((entry) => entry.value === style)?.label ?? style}`;
}

/** The window id in a window's or its tab bar's label (domain/windows.rs,
 *  WindowId::from_label). */
export function windowIdFromLabel(label: string): string | null {
  const match = /^(?:window|tabbar)-(.+)$/.exec(label);
  return match?.[1] ?? null;
}

/** What a bar sends: its style to every tab page, the notice to the visible
 *  one only, and only when the switch was made in this window. */
export function windowButtonStyleMessages(
  window: string,
  style: ButtonStyle,
  tabs: readonly string[],
  activeTab: string,
  notice: boolean,
): { label: string; payload: WindowButtonStylePayload }[] {
  return tabs.map((tab) => ({
    label: `tab-${tab}`,
    payload: { window, style, notice: notice && tab === activeTab },
  }));
}

function readWindowButtonStyles(): WindowButtonStyles {
  try {
    return parseWindowButtonStyles(window.localStorage.getItem(WINDOW_BUTTON_STYLES_STORAGE_KEY));
  } catch {
    return {};
  }
}

function storeWindowButtonStyle(windowId: string, style: ButtonStyle): void {
  try {
    window.localStorage.setItem(
      WINDOW_BUTTON_STYLES_STORAGE_KEY,
      serializeWindowButtonStyles(withWindowButtonStyle(readWindowButtonStyles(), windowId, style)),
    );
  } catch (error) {
    console.error("Failed to store the window's button style:", error);
  }
}

/** Put `style` on `root`. */
export function applyButtonStyle(style: ButtonStyle, root: HTMLElement = document.documentElement): void {
  if (style === "macos") root.removeAttribute("data-buttons");
  else root.setAttribute("data-buttons", style);
}

/** The style this page draws. */
export function shownButtonStyle(root: HTMLElement = document.documentElement): ButtonStyle {
  const style = root.getAttribute("data-buttons");
  return isButtonStyle(style) ? style : DEFAULT_BUTTON_STYLE;
}

function ownLabel(): string | null {
  try {
    return getCurrentWebview().label;
  } catch {
    return null;
  }
}

function ownWindowAtCreation(): string | null {
  try {
    return windowIdFromLabel(getCurrentWebview().window.label);
  } catch {
    return null;
  }
}

function showNotice(style: ButtonStyle): void {
  window.dispatchEvent(new CustomEvent<string>(BUTTON_STYLE_NOTICE_EVENT, { detail: buttonStyleNoticeTitle(style) }));
}

// ── Tab bar ───────────────────────────────────────────────────────────────

/** Before the bar's first paint: its window's stored style. */
export function applyBarButtonStyle(): void {
  const label = ownLabel();
  applyButtonStyle(buttonStyleOfWindow(readWindowButtonStyles(), label === null ? null : windowIdFromLabel(label)));
}

/** Send the window's style to its tab pages. */
export function sendWindowButtonStyle(
  windowId: string,
  style: ButtonStyle,
  tabs: readonly string[],
  activeTab: string,
  notice: boolean,
): void {
  for (const { label, payload } of windowButtonStyleMessages(windowId, style, tabs, activeTab, notice)) {
    void emitTo(label, WINDOW_BUTTON_STYLE_EVENT, payload).catch((error: unknown) => {
      console.error("Failed to send the window's button style:", error);
    });
  }
}

/** The bar's menu chose `style` for its window. */
export function chooseWindowButtonStyle(windowId: string, style: ButtonStyle, tabs: readonly string[], activeTab: string): void {
  storeWindowButtonStyle(windowId, style);
  applyButtonStyle(style);
  sendWindowButtonStyle(windowId, style, tabs, activeTab, true);
}

/** The bar follows a step made in one of its pages. */
export function adoptWindowButtonStyleSet(windowId: string, style: ButtonStyle, tabs: readonly string[], activeTab: string): void {
  storeWindowButtonStyle(windowId, style);
  applyButtonStyle(style);
  sendWindowButtonStyle(windowId, style, tabs, activeTab, false);
}

// ── Tab page ──────────────────────────────────────────────────────────────

/** The window this page is in: the one it was created in until its bar
 *  says otherwise (a tab dragged into another window). */
let pageWindow: string | null = null;

/** Before the page's first paint: its window's stored style; then follow
 *  what its bar sends. */
export function followWindowButtonStyle(): void {
  pageWindow = ownWindowAtCreation();
  applyButtonStyle(buttonStyleOfWindow(readWindowButtonStyles(), pageWindow));
  void listenPage<WindowButtonStylePayload>(WINDOW_BUTTON_STYLE_EVENT, (event) => {
    pageWindow = event.payload.window;
    applyButtonStyle(event.payload.style);
    if (event.payload.notice) showNotice(event.payload.style);
  }).catch(() => {
    // Outside a Tauri page (a dev browser route) there is no bar to follow.
  });
}

/** ⌃⌥B in a tab page: step this page now and have its bar spread it. */
export function flipWindowButtonStyleHere(): void {
  const next = nextButtonStyle(shownButtonStyle());
  applyButtonStyle(next);
  showNotice(next);
  if (pageWindow === null) return;
  const payload: WindowButtonStyleSetPayload = { window: pageWindow, style: next };
  void emitTo(`tabbar-${pageWindow}`, WINDOW_BUTTON_STYLE_SET_EVENT, payload).catch((error: unknown) => {
    console.error("Failed to tell the bar about the button style:", error);
  });
}
