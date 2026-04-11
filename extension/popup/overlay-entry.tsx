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
  onDocClick: (e: MouseEvent) => void;
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
    // Rewrite :root{ to :root,:host{ so the same declarations apply to
    // the shadow host. Rules already using `:root, :host` (font vars
    // from @theme) are not matched by the narrower `:root{` pattern.
    cachedCss = raw.replace(/:root\{/g, ":root,:host{");
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
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

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
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color-scheme: dark light;
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
  shadow.appendChild(root);

  document.body.appendChild(host);

  // Click-outside-to-close: pointer-events:none on host means the real
  // target of outside clicks is the underlying page element (the event
  // still bubbles on window). We listen in capture phase on the window
  // and check composedPath() for the overlay host.
  function onDocClick(e: MouseEvent) {
    const path = e.composedPath?.() ?? [];
    if (path.includes(host)) return; // inside overlay
    closeClipperOverlay();
  }
  // Defer listener registration by one frame so the click that OPENED
  // the overlay doesn't immediately close it.
  setTimeout(() => {
    window.addEventListener("click", onDocClick, { capture: true });
  }, 0);

  const reactRoot = createRoot(root);
  reactRoot.render(<OverlayShell />);

  return { host, root: reactRoot, onDocClick };
}

export async function showClipperOverlay(): Promise<void> {
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
  window.removeEventListener("click", current.onDocClick, { capture: true });
  current.root.unmount();
  current.host.remove();
  current = null;
}

// Expose on isolated-world window so content.js can call these directly.
interface MineOverlayApi {
  show: () => void;
  hide: () => void;
  close: () => void;
}
const api: MineOverlayApi = {
  show: () => void showClipperOverlay(),
  hide: hideClipperOverlay,
  close: closeClipperOverlay,
};
(globalThis as unknown as { __mineOverlay: MineOverlayApi }).__mineOverlay = api;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "showClipperOverlay") {
    void showClipperOverlay();
    return false;
  }
  if (msg?.action === "hideClipperOverlay") {
    hideClipperOverlay();
    return false;
  }
  if (msg?.action === "closeClipperOverlay") {
    closeClipperOverlay();
    return false;
  }
  return false;
});
