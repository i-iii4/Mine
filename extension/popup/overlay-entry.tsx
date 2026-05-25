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
}

let current: OverlayHandle | null = null;
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

async function mount(): Promise<OverlayHandle> {
  ensureFontsLoaded();
  const css = await loadCss();

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

    #root button,
    #root input,
    #root textarea,
    #root select {
      font: inherit;
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
  // the overlay doesn't immediately close it.
  setTimeout(() => {
    window.addEventListener("pointerdown", onOutsidePointer, { capture: true });
    window.addEventListener("mousedown", onOutsidePointer, { capture: true });
  }, 0);

  const reactRoot = createRoot(appRoot);
  reactRoot.render(<OverlayShell portalContainer={floatingRoot} />);

  return { host, root: reactRoot, onOutsidePointer };
}

/// Fresh invocation: context menu / toolbar icon / extension icon.
/// Always remounts so PopupApp.init() runs fresh and consumes the
/// latest contextMenuData. Any previous overlay state (currentType,
/// metadata, title) is DESTROYED. Use this when the intent is
/// "user opened the clipper with new input."
export async function showClipperOverlay(): Promise<void> {
  if (current) {
    closeClipperOverlay();
  }
  current = await mount();
}

/// Resume after a transient hide: screenshot capture, crop flow.
/// PRESERVES React state — user's in-progress editing (title,
/// selected tags, currentType) survives. Use this when the intent
/// is "the overlay was temporarily hidden and now should reappear
/// with the same content." If the overlay was closed (not just
/// hidden) or never mounted, falls back to a fresh mount.
export async function resumeClipperOverlay(): Promise<void> {
  if (current) {
    current.host.style.display = "";
    return;
  }
  current = await mount();
}

export function hideClipperOverlay(): void {
  if (current) current.host.style.display = "none";
}

export function closeClipperOverlay(): void {
  if (!current) return;
  window.removeEventListener("pointerdown", current.onOutsidePointer, { capture: true });
  window.removeEventListener("mousedown", current.onOutsidePointer, { capture: true });
  current.root.unmount();
  current.host.remove();
  current = null;
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
}
const api: MineOverlayApi = {
  show: () => void resumeClipperOverlay(),
  hide: hideClipperOverlay,
  close: closeClipperOverlay,
};
(globalThis as unknown as { __mineOverlay: MineOverlayApi }).__mineOverlay = api;

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handled = onRuntimeMessage(msg);
  if (handled) sendResponse({ ok: true });
  return false;
});
