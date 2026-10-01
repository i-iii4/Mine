import { createRoot, type Root } from "react-dom/client";
import { OverlayShell } from "./OverlayShell";

// Overlay entry — injected into the active tab's content-script isolated
// world via chrome.scripting.executeScript. Mounts <PopupApp /> inside a
// closed Shadow DOM so page styles cannot leak in and our styles cannot
// leak out.
//
// CSS is loaded at runtime from dist/assets/popup.css (the SAME bundle
// the detached window uses). This avoids duplicating Tailwind generation
// between two builds: all utility classes that work in the window
// context also work in the overlay. The CSS is post-processed to rewrite
// `:root` selectors to `:root, :host` so custom properties resolve
// inside Shadow DOM (where `:root` matches nothing).

interface OverlayHandle {
  host: HTMLDivElement;
  root: Root;
  onOutsidePointer: (e: MouseEvent | PointerEvent) => void;
  /// What had the keyboard on the page before the clipper took it.
  returnFocus: Element | null;
  /// Whether the keyboard was in the clipper when it was hidden for a
  /// screenshot or a crop, and on which of its elements.
  hiddenWithKeyboard: boolean;
  focusBeforeHide: Element | null;
}

let current: OverlayHandle | null = null;
// The mount under way, one per tab. An open that comes while it runs gets
// this mount instead of a second editor: the editor has not read its launch
// yet and opens with the latest one (SPEC_AUDIT_FIXES.md, Г3.1). A pending
// extension update counts the clipper open from the moment the mount starts,
// not once it has finished: its draft and its requests reach background right
// after (SPEC_CLIPPER.md, К4; SPEC_AUDIT_FIXES.md, В4.6).
let pendingMount: Promise<void> | null = null;
// Moves on with every close. A mount that a close overtook shows nothing.
let overlayGeneration = 0;
let cachedCss: string | null = null;

async function loadCss(): Promise<string> {
  if (cachedCss !== null) return cachedCss;
  try {
    const url = chrome.runtime.getURL("dist/assets/popup.css");
    const raw = await fetch(url).then((r) => r.text());
    // Tailwind v4 + shadcn emit all color custom properties on :root only.
    // Inside Shadow DOM, :root matches nothing — no variables, no styles.
    // Rewrite :root { ... } to :root,:host { ... } so the same declarations apply to
    // the shadow host. Rules already using `:root, :host` (font vars
    // from @theme) are not matched by the narrower `:root(?=\s*\{)` pattern.
    cachedCss = raw.replace(/:root(?=\s*\{)/g, ":root,:host");
  } catch (e) {
    console.error("[Mine] failed to load popup.css:", e);
    cachedCss = "";
  }
  return cachedCss;
}

// Fonts must be registered against the document, not inside Shadow DOM —
// @font-face declarations inside a shadow root are honoured only for the
// root itself, not for descendants. document.fonts.add() registers them
// globally on the page document, which shadow descendants inherit.
let fontsLoaded = false;
async function ensureFontsLoaded() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  try {
    const sansUrl = chrome.runtime.getURL("dist/fonts/Geist-Variable.woff2");
    const monoUrl = chrome.runtime.getURL("dist/fonts/GeistMono-Variable.woff2");
    const sans = new FontFace("Geist", `url(${sansUrl}) format("woff2")`, {
      weight: "100 900",
      style: "normal",
      display: "swap",
    });
    const mono = new FontFace("Geist Mono", `url(${monoUrl}) format("woff2")`, {
      weight: "100 900",
      style: "normal",
      display: "swap",
    });
    await Promise.all([sans.load(), mono.load()]);
    document.fonts.add(sans);
    document.fonts.add(mono);
  } catch {
    // Fall back to the next font in the stack
  }
}

/// The editor of mount `generation`, or `null` when a close came while the
/// stylesheet was loading.
async function mount(generation: number): Promise<OverlayHandle | null> {
  const returnFocus = document.activeElement;
  ensureFontsLoaded();
  const css = await loadCss();
  if (generation !== overlayGeneration) return null;

  const host = document.createElement("div");
  host.setAttribute("data-mine-clipper-overlay", "");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

  // Open mode: event.composedPath() inside capture-phase window
  // listeners reveals full path into the shadow tree. Closed mode
  // would hide internals and break click-outside detection for nested
  // components like VaultSelect that use containerRef.current + path
  // inclusion to distinguish inside/outside clicks. Extension host is
  // not security-sensitive, so open mode is fine here.
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = css + `
    :host {
      all: initial;
      display: block;
      --spacing: 4px;
      --container-xs: 320px;
      --container-sm: 384px;
      --container-md: 448px;
      --container-lg: 512px;
      --container-xl: 576px;
      --container-2xl: 672px;
      --text-xs: 12px;
      --text-xs--line-height: 16px;
      --text-sm: 12px;
      --text-sm--line-height: 16px;
      --text-base: 14px;
      --text-base--line-height: 20px;
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 20px;
      color: var(--foreground);
      color-scheme: dark light;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-size-adjust: 100%;
      -webkit-text-size-adjust: 100%;
    }

    #root {
      all: initial;
      display: block;
      min-height: 100vh;
      --spacing: 4px;
      --container-xs: 320px;
      --container-sm: 384px;
      --container-md: 448px;
      --container-lg: 512px;
      --container-xl: 576px;
      --container-2xl: 672px;
      --text-xs: 12px;
      --text-xs--line-height: 16px;
      --text-sm: 12px;
      --text-sm--line-height: 16px;
      --text-base: 14px;
      --text-base--line-height: 20px;
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 20px;
      color: var(--foreground);
      color-scheme: dark light;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-size-adjust: 100%;
      -webkit-text-size-adjust: 100%;
    }

    #app-root,
    #floating-root {
      display: block;
    }

    #floating-root {
      pointer-events: auto;
    }

    #root *, #root *::before, #root *::after {
      box-sizing: border-box;
    }

    /* In the base layer, like Tailwind's own preflight: an unlayered rule
       outranks every utility, and font: inherit took the size and weight
       away from every button (SPEC_AUDIT_FIXES.md, А4.2). */
    @layer base {
      #root button,
      #root input,
      #root textarea,
      #root select {
        font: inherit;
      }
    }

    /* Tailwind v4 uses CSS @property rules (initial-value: solid) for
       --tw-border-style, --tw-outline-style, --tw-divide-y-reverse, etc.
       @property declarations only register on the document level, not
       inside a Shadow DOM, so the initial-value never applies here —
       --tw-border-style resolves to unset and .border { border-style:
       var(--tw-border-style) } renders as border-style:none. We set the
       values explicitly on every element in the shadow tree to restore
       visible borders, outlines and dividers. */
    *, *::before, *::after {
      --tw-border-style: solid;
      --tw-outline-style: solid;
      --tw-divide-y-reverse: 0;
      --tw-divide-x-reverse: 0;
    }
  `;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.id = "root";
  const appRoot = document.createElement("div");
  appRoot.id = "app-root";
  const floatingRoot = document.createElement("div");
  floatingRoot.id = "floating-root";
  root.append(appRoot, floatingRoot);
  shadow.appendChild(root);

  document.body.appendChild(host);

  // Click-outside-to-close: use pointer/mouse down and a geometry check
  // against the actual panel. Relying only on `click` + composedPath is
  // fragile on host pages that intercept click events or when the full-page
  // shadow host is pointer-transparent.
  function isInsidePanel(e: MouseEvent | PointerEvent): boolean {
    const panel = shadow.querySelector("[data-mine-clipper-panel]");
    if (panel instanceof HTMLElement) {
      const rect = panel.getBoundingClientRect();
      return (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      );
    }
    const path = e.composedPath?.() ?? [];
    return path.includes(host);
  }

  function onOutsidePointer(e: MouseEvent | PointerEvent) {
    // `hideClipperOverlay()` is a transient state used while Chrome captures
    // screenshots and while the page-level crop overlay is active. The React
    // overlay must keep its state alive during that period; page pointer
    // events belong to the crop/capture flow, not to click-outside close.
    if (host.style.display === "none") return;
    if (isInsidePanel(e)) return;
    closeClipperOverlay();
  }
  // Defer listener registration by one frame so the click that OPENED
  // the overlay doesn't immediately close it. An editor closed before then
  // registers nothing: its listener would close the next editor.
  setTimeout(() => {
    if (!host.isConnected) return;
    window.addEventListener("pointerdown", onOutsidePointer, { capture: true });
    window.addEventListener("mousedown", onOutsidePointer, { capture: true });
  }, 0);

  const reactRoot = createRoot(appRoot);
  reactRoot.render(<OverlayShell portalContainer={floatingRoot} />);

  return { host, root: reactRoot, onOutsidePointer, returnFocus, hiddenWithKeyboard: false, focusBeforeHide: null };
}

/// Fresh invocation: context menu / toolbar icon / extension icon.
/// Remounts so PopupApp.init() runs fresh and consumes the latest
/// launch. Any previous overlay state (currentType, metadata, title)
/// is DESTROYED. Use this when the intent is "user opened the clipper
/// with new input." An open while a mount is under way gets that
/// mount: its editor has not read its launch yet (Г3.1).
export function showClipperOverlay(): Promise<void> {
  return pendingMount ?? beginMount(true);
}

/// Start the one mount of this tab. `replace` closes the editor shown now;
/// the new one counts as opening before that close tells background, which
/// may otherwise apply a pending update in between (В4.6).
function beginMount(replace: boolean): Promise<void> {
  const previous = replace ? current : null;
  current = null;
  const generation = overlayGeneration;
  const mounting = mount(generation).then((handle) => {
    if (handle && generation === overlayGeneration) current = handle;
    else if (handle) unmount(handle);
  }).finally(() => {
    if (pendingMount === mounting) pendingMount = null;
  });
  pendingMount = mounting;
  if (previous) {
    unmount(previous);
    reportClosed();
  }
  return mounting;
}

/// Whether a clipper is open or opening in this tab.
export function isClipperOverlayOpen(): boolean {
  return current !== null || pendingMount !== null;
}

/// Hidden for a screenshot or a crop: still open, but the keyboard belongs to
/// the page and the crop until it comes back (SPEC_AUDIT_FIXES.md, В4.3).
export function isClipperOverlayHidden(): boolean {
  return current !== null && current.host.style.display === "none";
}

/// Resume after a transient hide: screenshot capture, crop flow.
/// PRESERVES React state — user's in-progress editing (title,
/// selected tags, currentType) survives. Use this when the intent
/// is "the overlay was temporarily hidden and now should reappear
/// with the same content." If the overlay was closed (not just
/// hidden) or never mounted, falls back to a fresh mount.
export function resumeClipperOverlay(): Promise<void> {
  if (current) {
    current.host.style.display = "";
    restoreKeyboard(current);
    return Promise.resolve();
  }
  return pendingMount ?? beginMount(false);
}

/// Hiding the host (display:none) takes the keyboard from whatever had it in
/// the panel, and the browser hands it to the page. Tab and the arrows then
/// work only inside the panel, so the clipper remembers where the keyboard
/// was and brings it back on resume (SPEC_AUDIT_FIXES.md, Б4.9).
export function hideClipperOverlay(): void {
  if (!current) return;
  const { host } = current;
  // Before a capture the page hides every Mine layer again; that second hide
  // finds the keyboard already on the page and must not forget the first.
  if (host.style.display !== "none") {
    current.hiddenWithKeyboard = document.activeElement === host;
    current.focusBeforeHide = current.hiddenWithKeyboard ? host.shadowRoot?.activeElement ?? null : null;
  }
  host.style.display = "none";
}

/// Give the keyboard back to the element that had it before the hide, or to
/// the panel when that element is gone or cannot take focus now. The page
/// keeps the keyboard if it was there, or if someone moved it there since.
function restoreKeyboard(handle: OverlayHandle): void {
  const { host, hiddenWithKeyboard, focusBeforeHide } = handle;
  handle.hiddenWithKeyboard = false;
  handle.focusBeforeHide = null;
  const shadow = host.shadowRoot;
  if (!hiddenWithKeyboard || !shadow) return;
  const active = document.activeElement;
  if (active !== null && active !== document.body && active !== host) return;
  if (focusBeforeHide instanceof HTMLElement && focusBeforeHide.isConnected && shadow.contains(focusBeforeHide)) {
    focusBeforeHide.focus({ preventScroll: true });
    if (shadow.activeElement === focusBeforeHide) return;
  }
  shadow.querySelector<HTMLElement>("[data-mine-clipper-panel]")?.focus({ preventScroll: true });
}

/// Close the editor of this tab, or the one still mounting: a mount that this
/// close overtakes never shows (Г3.1).
export function closeClipperOverlay(): void {
  const handle = current;
  if (!handle && !pendingMount) return;
  current = null;
  pendingMount = null;
  overlayGeneration += 1;
  if (handle) unmount(handle);
  reportClosed();
}

function unmount(handle: OverlayHandle): void {
  const { host, returnFocus } = handle;
  const keyboardInside = host.contains(document.activeElement);
  window.removeEventListener("pointerdown", handle.onOutsidePointer, { capture: true });
  window.removeEventListener("mousedown", handle.onOutsidePointer, { capture: true });
  handle.root.unmount();
  host.remove();
  // Escape and the close after Save give the keyboard back to what had it
  // on the page (А6.12). A click outside moves focus where it lands itself.
  if (
    keyboardInside
    && returnFocus instanceof HTMLElement
    && returnFocus !== document.body
    && returnFocus.isConnected
  ) {
    returnFocus.focus({ preventScroll: true });
  }
}

/// A pending extension update applies once nothing is open (SPEC_CLIPPER.md, К4).
function reportClosed(): void {
  try {
    void chrome.runtime.sendMessage({ target: "background", action: "mineClipperClosed" }).catch(() => undefined);
  } catch {
    // The extension context is gone; there is nothing left to update.
  }
}

// Expose on isolated-world window so content.js and in-world code
// (useClipperState captureScreenshot) can call these directly.
// `show` is RESUME semantics — in-world callers always want to
// preserve state. Fresh-invocation callers go through the
// `showClipperOverlay` runtime message which routes to the remount
// path below.
interface MineOverlayApi {
  show: () => void;
  hide: () => void;
  close: () => void;
  isHidden: () => boolean;
}
const api: MineOverlayApi = {
  show: () => void resumeClipperOverlay(),
  hide: hideClipperOverlay,
  close: closeClipperOverlay,
  isHidden: isClipperOverlayHidden,
};

function onRuntimeMessage(msg: unknown) {
  if (typeof msg !== "object" || msg === null) return false;
  const action = (msg as { action?: unknown }).action;
  if (action === "showClipperOverlay") {
    void showClipperOverlay();
    return true;
  }
  if (action === "hideClipperOverlay") {
    hideClipperOverlay();
    return false;
  }
  if (action === "closeClipperOverlay") {
    closeClipperOverlay();
    return false;
  }
  return false;
}

function onMessage(msg: unknown, _sender: unknown, sendResponse: (response: unknown) => void): boolean {
  // A pending extension update asks before reloading (SPEC_CLIPPER.md, К4):
  // a hidden overlay (screenshot, crop) and a mounting one are open editors.
  if (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { action?: unknown }).action === "mineClipperIsOpen"
  ) {
    sendResponse({ open: isClipperOverlayOpen() });
    return false;
  }
  const handled = onRuntimeMessage(msg);
  if (handled) sendResponse({ ok: true });
  return false;
}

// The bundle can run again in a page that already has it: two openings that
// both inject it, or the static Instagram script and an injection. A second
// instance would answer background beside the first and mount a second
// editor with every open, so one instance per page answers (Г3.1). A script
// left by a reloaded extension cannot reach it anymore and gives way.
interface OverlayInstance {
  /// Whether the extension that ran this instance is still the running one.
  alive: () => boolean;
}
const INSTANCE_KEY = "__mineOverlayInstance";

function claimPage(): boolean {
  const page = globalThis as unknown as { [INSTANCE_KEY]?: OverlayInstance; __mineOverlay?: MineOverlayApi };
  if (page[INSTANCE_KEY]?.alive()) return false;
  const runtime = chrome.runtime;
  page[INSTANCE_KEY] = {
    alive: () => {
      try {
        return typeof runtime?.id === "string";
      } catch {
        // A context the browser has torn down may refuse even this read.
        return false;
      }
    },
  };
  page.__mineOverlay = api;
  return true;
}

if (claimPage()) chrome.runtime.onMessage.addListener(onMessage);
