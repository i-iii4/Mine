import { createRoot, type Root } from "react-dom/client";
import { OverlayShell } from "./OverlayShell";
import type { ClipperEdits } from "./lib/clipperEdits";
import { clearOpenClip, parseOpenClip, type OpenClip } from "./lib/openClip";
import { DEFAULT_OVERLAY_BOUNDS, OVERLAY_BOUNDS_KEY, parseOverlayBounds, type OverlayBounds } from "./lib/overlayBounds";
import { rewriteRootForShadow } from "./lib/shadowRootCss";
import { SYSTEM_SANS_STACK } from "@/lib/fontChoice";

// Overlay entry — injected into the active tab's content-script isolated
// world via chrome.scripting.executeScript. Mounts <PopupApp /> inside a
// closed Shadow DOM so page styles cannot leak in and our styles cannot
// leak out.
//
// CSS is loaded at runtime from dist/assets/popup.css (the SAME bundle
// the detached window uses). This avoids duplicating Tailwind generation
// between two builds: all utility classes that work in the window
// context also work in the overlay. The CSS is post-processed so every bare
// `:root` selector also selects `:host` and custom properties resolve
// inside Shadow DOM (where `:root` matches nothing).

interface OverlayHandle {
  host: HTMLDivElement;
  root: Root;
  /// What had the keyboard on the page before the person clicked into the
  /// clipper.
  returnFocus: Element | null;
  /// Whether the keyboard was in the clipper when it was hidden for a
  /// screenshot or a crop, and on which of its elements.
  hiddenWithKeyboard: boolean;
  focusBeforeHide: Element | null;
  /// Whether the person changed this clip; the editor sets it.
  edits: ClipperEdits;
  /// The page address the clip was opened for.
  pageUrl: string;
  /// Stops keeping the host in the document.
  release: () => void;
}

let current: OverlayHandle | null = null;
// The mount under way, one per tab. An open that comes while it runs gets
// this mount instead of a second editor: the editor has not read its launch
// yet and opens with the latest one (SPEC_AUDIT_FIXES.md, Г3.1). A pending
// extension update counts the clipper open from the moment the mount starts,
// not once it has finished: its requests reach background right after
// (SPEC_CLIPPER.md, К4; SPEC_AUDIT_FIXES.md, В4.6).
let pendingMount: Promise<void> | null = null;
// Moves on with every close. A mount that a close overtook shows nothing.
let overlayGeneration = 0;
let cachedCss: string | null = null;

/// The stylesheet of the overlay. One that cannot be read fails the mount:
/// an overlay without its styles is unusable, and background opens the
/// clipper window instead. A failure is not kept, the next open reads again
/// (SPEC_DEEP_AUDIT.md, Е3.12).
async function loadCss(): Promise<string> {
  if (cachedCss !== null) return cachedCss;
  const url = chrome.runtime.getURL("dist/assets/popup.css");
  const response = await fetch(url);
  if (response.ok === false) throw new Error(`The clipper's stylesheet did not load (HTTP ${response.status})`);
  const raw = await response.text();
  // Tailwind v4 + shadcn emit all color custom properties on :root only.
  // Inside Shadow DOM, :root matches nothing — no variables, no styles.
  // Every bare :root selector, alone or in a selector list such as the
  // colour ladder's `:root, [data-theme]`, also selects the shadow host.
  cachedCss = rewriteRootForShadow(raw);
  return cachedCss;
}

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/// Whether this document can hold the overlay: an HTML document with a body.
/// An SVG or XML page has neither, and its elements cannot host a shadow
/// root (SPEC_DEEP_AUDIT.md, Е3.8).
function documentHoldsOverlay(): boolean {
  return document.body !== null && document.documentElement?.namespaceURI === XHTML_NAMESPACE;
}

/// The place and size the person gave the overlay before, read before the
/// overlay shows so that it opens there (SPEC_CLIPPER.md, Р10).
async function loadBounds(): Promise<OverlayBounds> {
  try {
    const stored = await chrome.storage.local.get(OVERLAY_BOUNDS_KEY);
    return parseOverlayBounds(stored?.[OVERLAY_BOUNDS_KEY]);
  } catch (cause) {
    console.warn("[Mine] overlay opens in its default place:", cause);
    return DEFAULT_OVERLAY_BOUNDS;
  }
}

/// Keep the overlay's host in the document while the editor is open: a page
/// that replaces its body or clears it on an in-page navigation takes the
/// overlay with it otherwise (SPEC_CLIPPER.md, «Доработки после живого
/// просмотра», Р6). The returned function stops it, before the overlay's own
/// removal.
function keepInDocument(host: HTMLElement): () => void {
  let watchedBody: HTMLElement | null = null;
  const bodyObserver = new MutationObserver(check);
  const rootObserver = new MutationObserver(check);
  function watchBody() {
    const body = document.body;
    if (body === watchedBody) return;
    bodyObserver.disconnect();
    watchedBody = body;
    if (body) bodyObserver.observe(body, { childList: true });
  }
  function check() {
    watchBody();
    if (!host.isConnected) (document.body ?? document.documentElement).appendChild(host);
  }
  rootObserver.observe(document.documentElement, { childList: true });
  watchBody();
  return () => {
    bodyObserver.disconnect();
    rootObserver.disconnect();
  };
}

/// The editor of mount `generation`, or `null` when a close came while the
/// stylesheet was loading. `returnFocus` is what had the keyboard on the page
/// when the editor opened; `restored` is the clip it reopens after its page
/// changed (Р7), or `null` for a new clip.
async function mount(generation: number, returnFocus: Element | null, restored: OpenClip | null): Promise<OverlayHandle | null> {
  if (!documentHoldsOverlay()) throw new Error("This page cannot show the clipper overlay");
  const [css, bounds] = await Promise.all([loadCss(), loadBounds()]);
  if (generation !== overlayGeneration) return null;
  if (!documentHoldsOverlay()) throw new Error("This page cannot show the clipper overlay");

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
      font-family: ${SYSTEM_SANS_STACK};
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
      /* all: initial gives the full-viewport root pointer events back; the
         page under the overlay takes every click, scroll and drag outside
         the panel (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р5). */
      pointer-events: none;
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
      font-family: ${SYSTEM_SANS_STACK};
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
  const release = keepInDocument(host);

  // The page under the overlay keeps working: a click outside the panel goes
  // to the page and never closes the clipper; only its close button and Save
  // do (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р5).
  const edits: ClipperEdits = { changed: restored?.edited ?? false };

  const reactRoot = createRoot(appRoot);
  reactRoot.render(<OverlayShell portalContainer={floatingRoot} edits={edits} restored={restored} initialBounds={bounds} />);

  return {
    host, root: reactRoot, returnFocus, hiddenWithKeyboard: false, focusBeforeHide: null,
    edits, pageUrl: restored?.pageUrl ?? window.location.href, release,
  };
}

/// Fresh invocation: context menu / toolbar icon / extension icon.
/// Remounts so PopupApp.init() runs fresh and consumes the latest
/// launch; the previous editor and its clip are gone. A clip with edits is
/// kept instead, unless the launch brings new material (a context-menu
/// target, a post already read) or the page shows another address than the
/// clip's (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч11). The kept clip does not take
/// the keyboard: the clipper takes it only when clicked (SPEC_CLIPPER.md, Р5).
/// An open while a mount is under way gets that mount: its editor has not
/// read its launch yet (Г3.1).
export function showClipperOverlay(freshMaterial = true): Promise<void> {
  if (pendingMount) return pendingMount;
  if (current && current.edits.changed && !freshMaterial && current.pageUrl === window.location.href) {
    return Promise.resolve();
  }
  return beginMount(true, null);
}

/// A new document in this tab while its overlay was open: the overlay comes
/// back with the clip background kept for the tab, where it was, without
/// taking the keyboard (SPEC_CLIPPER.md, «Доработки после живого просмотра»,
/// Р7). An overlay already open here is the live clip and stays.
export function restoreClipperOverlay(clip: OpenClip): Promise<void> {
  if (pendingMount) return pendingMount;
  if (current) return Promise.resolve();
  return beginMount(false, clip);
}

/// Start the one mount of this tab. `replace` closes the editor shown now;
/// the new one counts as opening before that close tells background, which
/// may otherwise apply a pending update in between (В4.6). The replaced clip
/// is gone: background stops keeping it, and the new editor hands over its
/// own (Ч12).
function beginMount(replace: boolean, restored: OpenClip | null): Promise<void> {
  const previous = replace ? current : null;
  current = null;
  const generation = overlayGeneration;
  const mounting = mount(generation, pageKeyboardOwner(previous), restored).then((handle) => {
    if (handle && generation === overlayGeneration) current = handle;
    else if (handle) unmount(handle);
  }).finally(() => {
    if (pendingMount === mounting) pendingMount = null;
  });
  pendingMount = mounting;
  if (previous) {
    unmount(previous);
    clearOpenClip();
    reportClosed();
  }
  return mounting;
}

/// What has the keyboard on the page for the editor about to open. The editor
/// it replaces is closed only after the new one starts (В4.6): while that
/// editor, or its hide, keeps the keyboard off the page, the keyboard still
/// belongs to what that editor took it from (SPEC_AUDIT_FIXES.md, Д1.3).
function pageKeyboardOwner(replaced: OverlayHandle | null): Element | null {
  const active = document.activeElement;
  if (!replaced) return active;
  const onPage = active !== null && active !== document.body && !replaced.host.contains(active);
  return onPage ? active : replaced.returnFocus;
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
  return pendingMount ?? beginMount(false, null);
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
/// close overtakes never shows (Г3.1). The clip goes with it: background
/// keeps nothing for the tab (Ч12).
export function closeClipperOverlay(): void {
  const handle = current;
  if (!handle && !pendingMount) return;
  current = null;
  pendingMount = null;
  overlayGeneration += 1;
  if (handle) unmount(handle);
  clearOpenClip();
  reportClosed();
}

/// The document goes, to a new page or into the history cache: its overlay
/// goes with it, and the clip stays with background for the document shown
/// next. An overlay left in a cached page would come back with an old clip
/// (Р7).
function suspendClipperOverlay(): void {
  const handle = current;
  current = null;
  pendingMount = null;
  overlayGeneration += 1;
  if (handle) unmount(handle);
}

function unmount(handle: OverlayHandle): void {
  const { host, returnFocus } = handle;
  const keyboardInside = host.contains(document.activeElement);
  handle.release();
  handle.root.unmount();
  host.remove();
  // The close button and the close after Save give the keyboard back to what
  // had it on the page (А6.12). A click outside moves focus where it lands
  // itself.
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
  show: () => {
    resumeClipperOverlay().catch((error: unknown) => console.warn("[Mine] The clipper overlay did not open:", error));
  },
  hide: hideClipperOverlay,
  close: closeClipperOverlay,
  isHidden: isClipperOverlayHidden,
};

/// The opening a `showClipperOverlay` message asks for, or `null` for any
/// other message. Hide and close act at once and answer nothing.
function onRuntimeMessage(msg: unknown): Promise<void> | null {
  if (typeof msg !== "object" || msg === null) return null;
  const action = (msg as { action?: unknown }).action;
  if (action === "showClipperOverlay") {
    const message = msg as { freshMaterial?: unknown; restore?: unknown };
    if ("restore" in message) {
      // The clip background kept for this tab. One this version cannot open
      // is dropped rather than replaced by a capture of this page (Р7).
      const clip = parseOpenClip(message.restore);
      if (clip) return restoreClipperOverlay(clip);
      clearOpenClip();
      return Promise.resolve();
    }
    // A launch from a background that does not say treats as new material,
    // as every launch did before Ч11.
    return showClipperOverlay(message.freshMaterial !== false);
  }
  if (action === "hideClipperOverlay") hideClipperOverlay();
  if (action === "closeClipperOverlay") closeClipperOverlay();
  return null;
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
  const opening = onRuntimeMessage(msg);
  if (!opening) return false;
  // Background hears the outcome, not the request: an overlay that could not
  // open (no styles, an SVG or XML page) says so, and background opens the
  // clipper window instead (SPEC_DEEP_AUDIT.md, Е3.8).
  opening.then(
    () => sendResponse({ ok: true }),
    (error: unknown) => {
      console.warn("[Mine] The clipper overlay did not open:", error);
      sendResponse({ ok: false, code: "overlay_unavailable", error: error instanceof Error ? error.message : String(error) });
    },
  );
  return true;
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

if (claimPage()) {
  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener("pagehide", suspendClipperOverlay);
}
