import { createRoot, type Root } from "react-dom/client";
import { OverlayShell } from "./OverlayShell";
import popupCss from "./popup-layout.css?inline";

// Overlay entry — injected into the active tab's content-script isolated
// world via chrome.scripting.executeScript. Mounts <PopupApp /> inside a
// closed Shadow DOM so page styles cannot leak in and our styles cannot
// leak out. Exposes window.__mineOverlay so other scripts in the same
// isolated world (content.js — Instagram feed button, crop flow) can
// call showClipperOverlay() / hideClipperOverlay() / closeClipperOverlay()
// directly without message round-trips.

interface OverlayHandle {
  host: HTMLDivElement;
  root: Root;
}

let current: OverlayHandle | null = null;

// Fonts must live in the light DOM — @font-face inside Shadow DOM is not
// honoured by Chrome for child descendant text. document.fonts.add is
// the modern replacement; it registers the font globally on the page
// document, which Shadow DOM descendants pick up via CSS font-family.
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
    // Fonts fail gracefully — PopupApp will use the next available
    // font-family in the stack.
  }
}

function mount(): OverlayHandle {
  const host = document.createElement("div");
  host.setAttribute("data-mine-clipper-overlay", "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

  const shadow = host.attachShadow({ mode: "closed" });

  // Inject the same CSS bundle the detached popup uses. Tailwind v4
  // emits :root-scoped custom properties — we need them on :host too
  // so they resolve inside the shadow tree.
  const style = document.createElement("style");
  style.textContent = popupCss + `
    :host {
      all: initial;
      display: block;
      pointer-events: auto;
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color-scheme: dark light;
    }
  `;
  shadow.appendChild(style);

  // React mount point inside the shadow
  const root = document.createElement("div");
  root.id = "root";
  shadow.appendChild(root);

  document.body.appendChild(host);

  const reactRoot = createRoot(root);
  reactRoot.render(<OverlayShell onClose={closeClipperOverlay} />);

  return { host, root: reactRoot };
}

export function showClipperOverlay(): void {
  ensureFontsLoaded();
  if (current) {
    // Already mounted — just make sure it's visible (we might have hidden
    // it before entering crop mode)
    current.host.style.display = "";
    return;
  }
  current = mount();
}

export function hideClipperOverlay(): void {
  if (current) current.host.style.display = "none";
}

export function closeClipperOverlay(): void {
  if (!current) return;
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
  show: showClipperOverlay,
  hide: hideClipperOverlay,
  close: closeClipperOverlay,
};
(globalThis as unknown as { __mineOverlay: MineOverlayApi }).__mineOverlay = api;

// Listener: when background tells us to show/hide the overlay (from
// chrome.action.onClicked or contextMenus.onClicked), react.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "showClipperOverlay") {
    showClipperOverlay();
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
