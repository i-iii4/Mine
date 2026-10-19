// Background service worker: context menus, native messaging bridge,
// and routing for the clipper UI between two contexts:
//
//   - Overlay (primary): injected content script bundle (overlay.js)
//     mounts React <PopupApp /> inside a closed Shadow DOM on the active
//     tab. No window chrome, no detached window — like Are.na/mymind.
//
//   - Detached window (fallback): chrome.windows.create with
//     dist/index.html, used when the active tab is a service page
//     (chrome://, chrome-extension://, view-source:, new tab) where
//     content scripts cannot run, or when overlay injection fails
//     (restrictive CSP, sandboxed frame).
//
// Routing happens in openClipperUi(tab): tries overlay first, falls
// back to detached window. Called from:
//   - chrome.action.onClicked (click extension icon)
//   - chrome.contextMenus.onClicked (right-click → Save ... to Mine)
//   - chrome.commands.onCommand (Alt+A shortcut)

// Standalone writing engine (О1–О4): saves clips straight to the granted
// folder when the native host is not there. Classic script, attaches to
// globalThis — the same convention every lib/ file follows. youtubeSource
// answers the channel of a YouTube clip. dist/build-identity.js is the build
// this worker's code belongs to, written by the extension build, and
// lib/extensionBuild.js compares it with the build of the files on disk (К4).
importScripts("dist/build-identity.js", "lib/extensionBuild.js", "generated/save-core/mine_core.js", "lib/mineCore.js", "lib/saveProtocol.js", "lib/standaloneVault.js", "lib/youtubeSource.js");

const HOST_NAME = "com.mine.clipper.v1";
// Must match extension/popup/popup-layout.css body { width: 360px }
// so detached window has no horizontal gap next to the content.
const POPUP_DEFAULT_WIDTH = 360;
const POPUP_DEFAULT_HEIGHT = 700;

// chrome.storage.session defaults to TRUSTED_CONTEXTS only — the clipper
// overlay runs inside a content-script isolated world which is untrusted,
// so without this the overlay's init() would throw "Access to storage is
// not allowed from this context" the first time it touches session storage.
// Wrapped in synchronous try/catch: on browser forks (DIA/Arc/Brave) the
// API may be missing entirely and throw on property access, which would
// kill the whole service worker and silently disable action.onClicked.
try {
  const p = chrome.storage.session?.setAccessLevel?.({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  });
  if (p && typeof p.catch === "function") p.catch(() => {});
} catch (e) {
  console.warn("[Mine] setAccessLevel unsupported:", e);
}

/** @typedef {chrome.tabs.Tab & { id: number }} TabWithId */
/**
 * A content-script group of the manifest. The chrome typings leave out `world`,
 * which Manifest V3 has: the page's own world (`MAIN`) or the extension's.
 * @typedef {NonNullable<chrome.runtime.Manifest["content_scripts"]>[number] & { world?: string }} ContentScriptGroup
 */
/** @typedef {ContentScriptGroup & { js: string[], matches: string[] }} PlannedGroup */
/** @typedef {chrome.runtime.MessageSender & { tab: TabWithId }} TabSender */
/**
 * What an opening of the clipper carries (`launchOptions`). The context-menu
 * target and the post a page already read pass through as they came.
 * @typedef {{ fallbackUrl?: string | null, contextMenu?: unknown, preloaded?: unknown, allowWindowFallback?: boolean }} OpenOptions
 */
/**
 * The clip of an open overlay as this worker keeps it: it reads only what
 * routes the clip and keeps the rest as the editor wrote it
 * (popup/lib/openClip.ts).
 * @typedef {{ version: number, pageUrl: string, screenshot?: unknown } & Record<string, unknown>} KeptClip
 */
/**
 * An answer of the helper, or this worker's own failure in its shape; the
 * worker reads only the fields it checks.
 * @typedef {Record<string, unknown>} HostReply
 */

// ── Values from outside this worker ──────────────────────────────────────
//
// Messages, the helper's answers, storage and network answers arrive as their
// writer made them. The worker reads them through these checks.

/// Whether the fields of `value` can be read: an object, not an array.
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// The fields of a stored record, or none when the value is not one.
/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return isRecord(value) ? value : {};
}

/// The items of a stored list, or none when the value is not one.
/** @param {unknown} value @returns {unknown[]} */
function asList(value) {
  return Array.isArray(value) ? value : [];
}

/// What a failure says: its `message`, else the value itself. A failure may be
/// an error of another realm or `chrome.runtime.lastError`, a plain object.
/** @param {unknown} error @returns {string} */
function failureText(error) {
  return String((isRecord(error) ? error.message : undefined) ?? error);
}

/// Whether the browser gave `tab` its id, the one every call addresses it by.
/** @param {chrome.tabs.Tab | undefined} tab @returns {tab is TabWithId} */
function hasTabId(tab) {
  return typeof tab?.id === "number";
}

/** @param {string | null | undefined} url */
function isContentScriptCompatible(url) {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://");
}

/** @param {chrome.contextMenus.OnClickData} info @param {chrome.tabs.Tab | undefined} tab */
function bestContextMenuPageUrl(info, tab) {
  return tab?.url || info?.pageUrl || info?.frameUrl || info?.srcUrl || info?.linkUrl || null;
}

/** @param {chrome.tabs.Tab | undefined} tab @param {string | null} [fallbackUrl] */
async function resolveClipperTarget(tab, fallbackUrl = null) {
  const tabId = tab?.id;
  let tabUrl = tab?.url || fallbackUrl || null;

  if (tabId && !tabUrl) {
    try {
      const freshTab = await chrome.tabs.get(tabId);
      tabUrl = freshTab?.url || null;
    } catch {
      // Keep the original null URL: openClipperUi will use detached fallback.
    }
  }

  return { tabId, tabUrl };
}

const CAPTURE_PAGE_MOVED = "The page changed while the screenshot was taken. Retake it.";

/// Whether two addresses name the same document. The address compares whole,
/// fragment included, the same rule content extraction follows.
/** @param {unknown} tabUrl @param {unknown} documentUrl */
function showsCaptureDocument(tabUrl, documentUrl) {
  if (typeof tabUrl !== "string" || typeof documentUrl !== "string") return false;
  try {
    return new URL(tabUrl).href === new URL(documentUrl).href;
  } catch {
    return false;
  }
}

/// Capture the viewport of `tabId` only while it is the tab in front of its
/// window: `captureVisibleTab` takes whatever tab is in front (SPEC_AUDIT_FIXES.md,
/// Ф6). The frame is the page the tab shows now and goes with the clip,
/// whichever page or link the clip was opened for, a Save link clip included
/// (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р9, 12.10.2026); a
/// frame taken while the tab changed address is dropped. An address a clipper
/// of an earlier build still sends with the request is not read.
/** @param {number} tabId @returns {Promise<string>} */
async function captureTabViewport(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    throw new Error("The page is not in front of its window. Bring it forward and retake the screenshot.");
  }
  await new Promise((resolve) => prepareTabForViewportCapture(tabId, () => resolve(undefined)));
  /** @type {string} */
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 95 }, (url) => {
      // The page shows its Mine buttons again whatever came of the frame
      // (SPEC_DEEP_AUDIT.md, Е3.13).
      finishTabViewportCapture(tabId);
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Capture failed"));
        return;
      }
      resolve(url);
    });
  });
  const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (front?.id !== tabId) {
    throw new Error("The page left the front while the screenshot was taken. Retake it.");
  }
  // The page may have moved while the frame was taken.
  if (!showsCaptureDocument(front.url, tab.url)) throw new Error(CAPTURE_PAGE_MOVED);
  return dataUrl;
}

/// Start the crop overlay in `tabId`, on the page it shows now, for any clip
/// (Р9). `cropId` names the crop of the editor that asked, and the crop
/// reports under it: only that editor takes the result (SPEC_AUDIT_FIXES.md,
/// Г3.3).
/** @param {number} tabId @param {string | null} cropId @returns {Promise<unknown>} */
function startCropInTab(tabId, cropId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "startCropOverlay", cropId }, (/** @type {unknown} */ resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: "Could not reach the page. Reload the tab after updating the extension." });
        return;
      }
      resolve(resp || { ok: true });
    });
  });
}

/// The frame is taken: the page brings back what it hid for it. Best-effort,
/// like the preparation; the page also brings it back on its own.
/** @param {number} tabId */
function finishTabViewportCapture(tabId) {
  if (typeof tabId !== "number") return;
  try {
    chrome.tabs.sendMessage(tabId, { action: "finishViewportCapture" }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // The tab is gone: there is nothing to bring back.
  }
}

/** @param {number} tabId @param {() => void} callback */
function prepareTabForViewportCapture(tabId, callback) {
  if (typeof tabId !== "number") {
    callback();
    return;
  }

  chrome.tabs.sendMessage(tabId, { action: "prepareViewportCapture" }, () => {
    // Best-effort only. If the page cannot be reached, capture still proceeds:
    // detached-window fallback and service pages have no content-script overlay.
    void chrome.runtime.lastError;
    callback();
  });
}

/// `freshMaterial`: the launch brings something to clip (a context-menu
/// target, a post already read), so it replaces a clip kept open with edits
/// (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч11). `extra` carries the clip of an
/// overlay reopened after its page changed (Ч12).
/** @param {number} tabId @param {boolean} freshMaterial @param {Record<string, unknown>} [extra] @returns {Promise<boolean>} */
function showExistingClipperOverlay(tabId, freshMaterial, extra = {}) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "showClipperOverlay", freshMaterial, ...extra }, (/** @type {unknown} */ resp) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(isRecord(resp) && Boolean(resp.ok));
    });
  });
}

// ── Clipper launches (SPEC_AUDIT_FIXES.md, Ф6) ────────────────────────────
//
// What one opening of the clipper carries (the page it opened for, the
// context-menu target, an Instagram post already read) belongs to that
// opening. It is kept under the source tab and read by the clipper that opened
// for that tab; a clipper anywhere else never sees it. The window used where
// the overlay cannot run finds its source tab through its window id.

const CLIPPER_LAUNCHES_KEY = "mineClipperLaunches";
const CLIPPER_WINDOW_SOURCES_KEY = "mineClipperWindowSources";
// Buffered page data older than this is a leftover, not the current opening.
const CLIPPER_LAUNCH_TTL_MS = 10 * 60 * 1000;

/** @param {string} key */
async function sessionRecord(key) {
  const stored = await chrome.storage.session.get(key);
  return asRecord(stored[key]);
}

// Every change to a clipper session value runs alone: it reads the value,
// changes it and writes it back before the next change reads. A worker woken
// by several events at once (a tab closing, Alt+A on another tab, a window
// closing) otherwise lets each write over the others' changes, and an opening
// loses its context-menu target or Instagram post (SPEC_AUDIT_FIXES.md, Б4.8).
/** @type {Promise<unknown>} */
let clipperSessionChanges = Promise.resolve();

/// `change` receives the stored value and returns `{ next, result }`. `next`
/// is written back unless it is `undefined`, which leaves storage untouched,
/// or `null`, which removes the key; `result` is what the returned promise
/// resolves to.
/**
 * @template R
 * @param {string} key
 * @param {(stored: unknown) => { next?: unknown, result?: R }} change
 * @returns {Promise<R | undefined>}
 */
function changeSessionValue(key, change) {
  return changeStoredValue(chrome.storage.session, key, change);
}

/// The same for a value of `area`; every change of either storage area runs
/// in the one queue.
/**
 * @template R
 * @param {chrome.storage.StorageArea} area
 * @param {string} key
 * @param {(stored: unknown) => { next?: unknown, result?: R }} change
 * @returns {Promise<R | undefined>}
 */
function changeStoredValue(area, key, change) {
  const run = clipperSessionChanges.then(async () => {
    const stored = await area.get(key);
    const { next, result } = change(stored[key]);
    if (next === null) await area.remove(key);
    else if (next !== undefined) await area.set({ [key]: next });
    return result;
  });
  clipperSessionChanges = run.catch(() => undefined);
  return run;
}

/**
 * @param {chrome.tabs.Tab | undefined} tab
 * @param {{ fallbackUrl?: string | null, contextMenu?: unknown, preloaded?: unknown }} source
 */
function recordClipperLaunch(tab, source) {
  if (!hasTabId(tab)) return Promise.resolve();
  return changeSessionValue(CLIPPER_LAUNCHES_KEY, (launches) => ({
    next: {
      ...asRecord(launches),
      [tab.id]: {
        sourceTabId: tab.id,
        sourceUrl: tab.url || source.fallbackUrl || null,
        sourceTitle: tab.title || null,
        contextMenu: source.contextMenu ?? null,
        preloaded: source.preloaded ?? null,
        createdAt: Date.now(),
      },
    },
  }));
}

/** @param {number} tabId */
function forgetClipperLaunch(tabId) {
  return changeSessionValue(CLIPPER_LAUNCHES_KEY, (stored) => {
    const launches = asRecord(stored);
    if (!(tabId in launches)) return {};
    const next = { ...launches };
    delete next[tabId];
    return { next };
  });
}

/** @param {number} windowId @param {number} tabId */
function rememberClipperWindowSource(windowId, tabId) {
  return changeSessionValue(CLIPPER_WINDOW_SOURCES_KEY, (sources) => ({ next: { ...asRecord(sources), [windowId]: tabId } }));
}

/// Bring forward the clipper window opened for `tabId`, if one is still open.
/** @param {number} tabId */
async function focusClipperWindowOf(tabId) {
  const sources = await sessionRecord(CLIPPER_WINDOW_SOURCES_KEY);
  for (const [windowId, sourceTabId] of Object.entries(sources)) {
    if (sourceTabId !== tabId) continue;
    try {
      await chrome.windows.update(Number(windowId), { focused: true });
      return true;
    } catch {
      // Closed before its removal reached this record.
      await forgetClipperWindowSource(Number(windowId));
    }
  }
  return false;
}

/** @param {number} windowId */
function forgetClipperWindowSource(windowId) {
  return changeSessionValue(CLIPPER_WINDOW_SOURCES_KEY, (stored) => {
    const sources = asRecord(stored);
    if (!(windowId in sources)) return {};
    const next = { ...sources };
    delete next[windowId];
    return { next };
  });
}

/** @param {chrome.runtime.MessageSender} sender */
function isExtensionPage(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

// The pages of X itself: posts, feeds, lists, profiles, search and X Pro decks.
const X_PAGE_ORIGINS = new Set(["https://x.com", "https://twitter.com", "https://pro.x.com"]);

/// Whether the message comes from the top frame of a tab showing X.
/** @param {chrome.runtime.MessageSender} sender @returns {sender is TabSender} */
function isXPageSender(sender) {
  if (typeof sender?.tab?.id !== "number" || sender.frameId !== 0) return false;
  try {
    return X_PAGE_ORIGINS.has(new URL(sender.url || sender.tab.url || "").origin);
  } catch {
    return false;
  }
}

/// The source tab of the clipper that asks: an overlay asks from the page's
/// own tab; the window asks from an extension page and is mapped to the tab
/// it opened for. The window may ask before its source is written, so it
/// waits a moment for it.
/** @param {chrome.runtime.MessageSender} sender @returns {Promise<number | null>} */
async function clipperSourceTab(sender) {
  if (!isExtensionPage(sender)) return sender.tab?.id ?? null;
  // A window without an id reads the key "undefined", as indexing always did.
  const windowId = String(sender.tab?.windowId);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sourceTabId = (await sessionRecord(CLIPPER_WINDOW_SOURCES_KEY))[windowId];
    if (typeof sourceTabId === "number") return sourceTabId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/// The launch of the asking clipper. Buffered page data is handed out once;
/// the source stays for a remount of the same clipper.
/** @param {chrome.runtime.MessageSender} sender @returns {Promise<Record<string, unknown> | null>} */
async function takeClipperLaunch(sender) {
  const sourceTabId = await clipperSourceTab(sender);
  if (typeof sourceTabId !== "number") return null;
  const launch = await changeSessionValue(CLIPPER_LAUNCHES_KEY, (stored) => {
    const launches = asRecord(stored);
    const taken = launches[sourceTabId];
    if (!isRecord(taken)) return { result: null };
    return { next: { ...launches, [sourceTabId]: { ...taken, contextMenu: null, preloaded: null } }, result: taken };
  });
  if (!launch) return null;
  // A launch without its time never expires, as `NaN > bound` never held.
  if (typeof launch.createdAt === "number" && Date.now() - launch.createdAt > CLIPPER_LAUNCH_TTL_MS) {
    return { ...launch, contextMenu: null, preloaded: null };
  }
  return launch;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetClipperLaunch(tabId).catch(() => undefined);
  void clearOpenClip(tabId).catch(() => undefined);
});

// ── The clip of an open overlay (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч12) ──────
//
// While an overlay is open, its editor hands its clip over after every change,
// and the clip is kept under the overlay's tab in session storage. A new
// document in the tab (a link, a reload, a page back from the history cache)
// asks for it, and the overlay opens again with the same clip
// (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р7). The close, the
// Save and the tab's close take it away; the browser's restart and a manual
// reload of the extension clear session storage with it, and the reload into
// an update carries it across (`carryKeptClips`). The list of tabs with an
// open clip (`OPEN_CLIP_TABS_KEY`, beside `anyEditorOpen`) is a key of its
// own: pages read it before asking.
const OPEN_CLIP_PREFIX = "mineOpenClip:";
// The clip format this version writes and opens (extension/popup/lib/openClip.ts).
const OPEN_CLIP_VERSION = 1;

/** @param {number} tabId */
function openClipKey(tabId) {
  return `${OPEN_CLIP_PREFIX}${tabId}`;
}

// Changes of one tab's clip run one at a time, in the order they came.
/** @type {Map<number, Promise<unknown>>} */
const openClipChanges = new Map();

// What a write of the clip kept: all of it, all but its frame, or nothing.
const OPEN_CLIP_KEPT = "kept";
const OPEN_CLIP_KEPT_WITHOUT_SCREENSHOT = "kept_without_screenshot";
const OPEN_CLIP_NOT_KEPT = "not_kept";

/** @param {number} tabId @param {string} key */
async function forgetOpenClipTab(tabId, key) {
  await chrome.storage.session.remove(key);
  await changeSessionValue(OPEN_CLIP_TABS_KEY, (tabs) => ({ next: asList(tabs).filter((id) => id !== tabId) }));
}

/// `change` receives the stored clip, which may be of another format, and
/// returns the clip to keep, `null` to forget it or `undefined` to leave it.
/**
 * @param {number} tabId
 * @param {(stored: unknown) => KeptClip | null | undefined} change
 * @returns {Promise<string | undefined>}
 */
function changeOpenClip(tabId, change) {
  const previous = openClipChanges.get(tabId) ?? Promise.resolve();
  const run = previous.then(async () => {
    const key = openClipKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key] ?? null;
    const next = change(stored);
    if (next === undefined) return undefined;
    if (next === null) {
      await forgetOpenClipTab(tabId, key);
      return undefined;
    }
    // Session storage holds 10 MB for every tab's clip together. A clip that
    // does not fit is kept without its frame, which the person can take
    // again on the page shown. One that does not fit even so is not kept:
    // an older copy would come back after the page changes as if it were
    // the clip. The editor hears which, and says it (SPEC_DEEP_AUDIT.md,
    // Е3.11).
    let kept = OPEN_CLIP_KEPT;
    try {
      await chrome.storage.session.set({ [key]: next });
    } catch (error) {
      console.warn("[Mine] open clip does not fit session storage:", failureText(error));
      kept = OPEN_CLIP_NOT_KEPT;
      if (next.screenshot) {
        try {
          await chrome.storage.session.set({ [key]: { ...next, screenshot: null } });
          kept = OPEN_CLIP_KEPT_WITHOUT_SCREENSHOT;
        } catch (withoutFrame) {
          console.warn("[Mine] open clip does not fit session storage without its screenshot:", failureText(withoutFrame));
        }
      }
    }
    if (kept === OPEN_CLIP_NOT_KEPT) {
      await forgetOpenClipTab(tabId, key);
      return kept;
    }
    await changeSessionValue(OPEN_CLIP_TABS_KEY, (stored) => {
      const tabs = asList(stored);
      return tabs.includes(tabId) ? {} : { next: [...tabs, tabId] };
    });
    return kept;
  });
  const settled = run.catch(() => undefined);
  openClipChanges.set(tabId, settled);
  void settled.then(() => {
    if (openClipChanges.get(tabId) === settled) openClipChanges.delete(tabId);
  });
  return run;
}

/// Keep the clip an overlay handed over. Without a `screenshot` field the
/// stored frame stays: the editor sends it only when it changed.
/** @param {number} tabId @param {KeptClip} clip */
function writeOpenClip(tabId, clip) {
  return changeOpenClip(tabId, (stored) => ({
    ...clip,
    screenshot: Object.prototype.hasOwnProperty.call(clip, "screenshot")
      ? clip.screenshot
      : (isRecord(stored) ? stored.screenshot : undefined) ?? null,
  }));
}

/** @param {number} tabId */
function clearOpenClip(tabId) {
  return changeOpenClip(tabId, (stored) => (stored === null ? undefined : null));
}

/** @param {number} tabId @returns {Promise<unknown>} */
async function readOpenClip(tabId) {
  await (openClipChanges.get(tabId) ?? Promise.resolve());
  const key = openClipKey(tabId);
  return (await chrome.storage.session.get(key))[key] ?? null;
}

/** @param {unknown} value @returns {value is KeptClip} */
function isOpenClip(value) {
  return isRecord(value) && value.version === OPEN_CLIP_VERSION && typeof value.pageUrl === "string";
}

/// Whether the message comes from the top frame of a page in a tab: the frame
/// an overlay lives in.
/** @param {chrome.runtime.MessageSender} sender @returns {sender is TabSender} */
function isPageTopFrame(sender) {
  return typeof sender?.tab?.id === "number" && sender.frameId === 0 && !isExtensionPage(sender);
}

/// A new document in `tab` while its overlay was open: the overlay opens
/// again there with the kept clip, by the delivery the icon uses. Openings of
/// one tab still run one at a time (Г3.1).
/** @param {TabWithId} tab */
function restoreOpenClipInTab(tab) {
  return trackClipperOpening(() => oneOpeningPerTab(tab.id, async () => {
    const clip = await readOpenClip(tab.id);
    if (!clip) return "none";
    // The overlay and its stylesheet are read from disk (К4). The reload
    // clears session storage: the clip waits for it with the openings after
    // the reload, and leaves session storage so that the reload can happen.
    const files = await filesOfRunningBuild();
    if (files === "reload") {
      await openAfterReload(tab, { restore: clip });
      await clearOpenClip(tab.id);
      return "deferred";
    }
    if (files === "refused") throw new Error(FILES_OF_ANOTHER_BUILD);
    await pageRefreshed(tab.id);
    const restore = { restore: clip };
    if (await showExistingClipperOverlay(tab.id, false, restore)) return "overlay";
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/overlay.js"] });
    if (await showExistingClipperOverlay(tab.id, false, restore)) return "overlay";
    throw new Error("overlay injected but did not acknowledge the kept clip");
  }));
}

// Openings of one tab, the last one under way. A second click or Alt+A while
// the first opening still injects the overlay would find no listener and
// inject the script again: two editors, one of them impossible to close. The
// second opening waits for the first and then finds its overlay
// (SPEC_AUDIT_FIXES.md, Г3.1). Other tabs open independently.
/** @type {Map<number, Promise<unknown>>} */
const clipperOpeningsByTab = new Map();

/** @template T @param {number | undefined} tabId @param {() => Promise<T>} open @returns {Promise<T>} */
function oneOpeningPerTab(tabId, open) {
  if (typeof tabId !== "number") return open();
  const previous = clipperOpeningsByTab.get(tabId) ?? Promise.resolve();
  const opening = previous.then(open);
  const settled = opening.catch(() => undefined);
  clipperOpeningsByTab.set(tabId, settled);
  void settled.then(() => {
    if (clipperOpeningsByTab.get(tabId) === settled) clipperOpeningsByTab.delete(tabId);
  });
  return opening;
}

// A pending extension update does not reload while a clipper is opening,
// including one that waits for an earlier opening of its tab (В4.6).
/** @param {chrome.tabs.Tab | undefined} tab @param {OpenOptions} [options] */
function openClipperUi(tab, options = {}) {
  return trackClipperOpening(() => oneOpeningPerTab(tab?.id, () => openClipperUiNow(tab, options)));
}

/** @param {chrome.tabs.Tab | undefined} tab @param {OpenOptions} options @returns {Promise<"overlay" | "window" | "deferred">} */
async function openClipperUiNow(tab, options) {
  // The overlay, its stylesheet and the clipper window are read from disk.
  // Files an update replaced are opened by the worker of their build, after
  // the reload into it (К4).
  const files = await filesOfRunningBuild();
  if (files === "reload") return openAfterReload(tab, { options: launchOptions(options) });
  if (files === "refused") {
    // The person learns why nothing opens, on the page they asked on
    // (19.10.2026).
    if (hasTabId(tab)) await tellInPage(tab.id, FILES_OF_ANOTHER_BUILD);
    throw new Error(FILES_OF_ANOTHER_BUILD);
  }
  await pageRefreshed(tab?.id);
  const { tabId, tabUrl } = await resolveClipperTarget(tab, options.fallbackUrl ?? null);
  const allowWindowFallback = options.allowWindowFallback !== false;
  // Every opening writes its own launch: a buffer left by an opening that
  // failed never reaches this one.
  await recordClipperLaunch(tab, {
    fallbackUrl: tabUrl,
    contextMenu: options.contextMenu ?? null,
    preloaded: options.preloaded ?? null,
  });
  const freshMaterial = Boolean(options.contextMenu || options.preloaded);

  if (tabId && isContentScriptCompatible(tabUrl)) {
    try {
      if (await showExistingClipperOverlay(tabId, freshMaterial)) {
        return "overlay";
      }

      // Inject the overlay bundle into the tab's isolated world.
      // Only inject when no overlay listener is already present. Re-injecting
      // while an overlay is open creates an independent module scope, leaving
      // the old host visible and unowned during screenshot capture; openings
      // of one tab run one at a time, so a second one never races this one.
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/overlay.js"],
      });
      if (await showExistingClipperOverlay(tabId, freshMaterial)) {
        return "overlay";
      }
      throw new Error("overlay injected but did not acknowledge show");
    } catch (err) {
      if (!allowWindowFallback) throw err;
      console.warn("[Mine] overlay injection failed, falling back to window", err);
      // fallthrough to detached window
    }
  }

  if (!allowWindowFallback) {
    throw new Error("Clipper overlay unavailable for this tab");
  }

  // The window already open for this tab keeps its clip and comes forward
  // unless the launch brings new material (Ч11).
  if (!freshMaterial && typeof tab?.id === "number" && await focusClipperWindowOf(tab.id)) {
    return "window";
  }

  // Fallback: detached popup window (service pages, CSP-restricted)
  const popupUrl = chrome.runtime.getURL("dist/index.html");
  const bounds = await resolvePopupBounds();
  let win;
  try {
    win = await chrome.windows.create({
      url: popupUrl,
      type: "popup",
      ...bounds,
    });
  } catch (error) {
    // A position remembered on a display that is gone, or a screen smaller
    // than the window: the browser refuses it. Open where the browser
    // chooses rather than not at all.
    console.warn("[Mine] clipper window position refused, opening at default:", failureText(error));
    win = await chrome.windows.create({
      url: popupUrl,
      type: "popup",
      width: bounds.width,
      height: bounds.height,
    });
  }
  if (win?.id) {
    rememberPopupWindow(win.id);
    if (hasTabId(tab)) await rememberClipperWindowSource(win.id, tab.id);
  }
  return "window";
}

// Icon click → open clipper UI. Alt+A shortcut (_execute_action in
// commands manifest) automatically triggers this listener when
// default_popup is absent, no separate handler needed.
chrome.action.onClicked.addListener((tab) => {
  // Diagnostic: badge "•" confirms the listener fired. If you see the
  // badge but no overlay, openClipperUi threw. If you don't see the
  // badge, the service worker is dead or default_popup is still set.
  try {
    chrome.action.setBadgeText({ text: "•" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
  } catch {
    // Badge is cosmetic; ignore environments where the action API is absent.
  }
  openClipperUi(tab).catch((e) => {
    console.error("[Mine] openClipperUi threw:", e);
    try {
      chrome.action.setBadgeText({ text: "ERR" });
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    } catch {
      // Badge is cosmetic; ignore if the action API is unavailable.
    }
  });
});

// ── Popup window bounds persistence ───────────────────────────────────────
//
// chrome.windows.create doesn't remember position between sessions. We persist
// last-known bounds in chrome.storage.local and restore them on next open.
// Tracked window IDs live in chrome.storage.session so we survive service
// worker restarts and only save bounds for OUR popup, not every popup in the
// browser.

const POPUP_WINDOW_IDS_KEY = "popupWindowIds";

/** @returns {Promise<{ width: number, height: number, left?: number, top?: number }>} */
async function resolvePopupBounds() {
  const saved = (await chrome.storage.local.get("popupBounds")).popupBounds;
  if (isRecord(saved) && typeof saved.left === "number") {
    // Always force width to match the body CSS — user may only customize
    // position and height. Height stays user-defined so they can resize.
    return {
      width: POPUP_DEFAULT_WIDTH,
      height: typeof saved.height === "number" ? saved.height : POPUP_DEFAULT_HEIGHT,
      left: saved.left,
      top: typeof saved.top === "number" ? saved.top : undefined,
    };
  }
  // Default: top-right of the currently focused browser window
  try {
    const current = await chrome.windows.getCurrent();
    // A window that reports no position leaves the place to the browser.
    if (current.left === undefined || current.top === undefined || current.width === undefined) {
      return { width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT };
    }
    return {
      width: POPUP_DEFAULT_WIDTH,
      height: POPUP_DEFAULT_HEIGHT,
      left: Math.round(current.left + current.width - POPUP_DEFAULT_WIDTH - 20),
      top: Math.round(current.top + 80),
    };
  } catch {
    return { width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT };
  }
}

// The list is changed through the same queue as the clipper launches: a window
// opening while another closes keeps both changes (Б4.8).
/** @param {number} windowId */
function rememberPopupWindow(windowId) {
  return changeSessionValue(POPUP_WINDOW_IDS_KEY, (ids) => ({ next: [...new Set([...asList(ids), windowId])] }));
}

/** @param {number | undefined} windowId */
async function isOurPopup(windowId) {
  const stored = await chrome.storage.session.get(POPUP_WINDOW_IDS_KEY);
  return asList(stored[POPUP_WINDOW_IDS_KEY]).includes(windowId);
}

/** @param {number} windowId */
function forgetPopupWindow(windowId) {
  return changeSessionValue(POPUP_WINDOW_IDS_KEY, (ids) => ({ next: asList(ids).filter((id) => id !== windowId) }));
}

chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (!(await isOurPopup(win.id))) return;
  await chrome.storage.local.set({
    popupBounds: {
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
    },
  });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const ours = await isOurPopup(windowId);
  await forgetPopupWindow(windowId);
  await forgetClipperWindowSource(windowId);
  if (ours) await reloadIfUpdated();
});

// ── Old drafts ────────────────────────────────────────────────────────────
//
// A clip lives only in an open clipper (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч6).
// The drafts an earlier version stored go once, on install or update; save
// records, settings and the browser folder stay. A removal that fails leaves
// keys nothing reads, and the next update tries again.
const OLD_DRAFT_KEY_PREFIXES = [
  "mineDurableDraft:",
  "mineDurableDraftRecord:",
  "mineDurableDraftIndex:",
  "mineDurableDraftMigration:",
];

async function removeOldDrafts() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => OLD_DRAFT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  await chrome.storage.session.remove("mineDraftBrowserSession");
}

chrome.runtime.onInstalled.addListener(() => {
  void removeOldDrafts().catch((error) => {
    console.warn("[Mine] old clipper drafts kept until the next update:", failureText(error));
  });
});

// ── Files of the running build (SPEC_CLIPPER.md, К4) ─────────────────────
//
// The overlay, its stylesheet, the clipper window, Defuddle and the save core
// are read from the copy on disk, which an update replaces while this worker
// keeps running the build it loaded. None of them reaches this worker's
// clipper unless it is of this build: an opening that finds another build on
// disk waits for the reload into it and is made by the worker of that build.
// Reloading the extension runs the build on disk, and so does a browser
// restart: every build has its own manifest version and worker wrapper, so
// Chromium registers the worker of the files on disk again (К4, 13.10.2026).

const FILES_OF_ANOTHER_BUILD = "The Mine extension files on disk do not match the running extension. Restart the browser or reload Mine on the extensions page to finish updating Mine.";
const EXTENSION_UPDATED = "Mine was updated. Close the clipper and open it again.";
const UPDATE_WAITS_FOR_CLIPPER = "Mine was updated. Close the open clipper to finish the update, then open Mine again.";

/// `same`, `reload` (pending now) or `refused`: lib/extensionBuild.js.
function filesOfRunningBuild() {
  return globalThis.MineExtensionBuild.filesOfRunningBuild();
}

// Openings that wait for the reload into the build on disk, by tab. The
// reload clears session storage, so they wait in local storage, and the
// worker of the new build takes them as it starts. A launch is made on the
// page it was asked on; the clip of an overlay whose page changed opens on
// whatever its tab shows (Р7). Older than CLIPPER_LAUNCH_TTL_MS, neither is.
const OPENINGS_AFTER_RELOAD_KEY = "mineOpeningsAfterReload";

/// What of an opening's options travels across the reload.
/** @param {Record<string, unknown>} options @returns {OpenOptions} */
function launchOptions(options) {
  return {
    fallbackUrl: typeof options.fallbackUrl === "string" ? options.fallbackUrl : null,
    contextMenu: options.contextMenu ?? null,
    preloaded: options.preloaded ?? null,
    allowWindowFallback: options.allowWindowFallback !== false,
  };
}

/// Keep `opening` of `tab` for the worker after the reload: `{ options }` for
/// a launch, `{ restore }` for a kept clip.
/** @param {chrome.tabs.Tab | undefined} tab @param {Record<string, unknown>} opening @returns {Promise<"deferred">} */
async function openAfterReload(tab, opening) {
  if (!hasTabId(tab)) return "deferred";
  await changeStoredValue(chrome.storage.local, OPENINGS_AFTER_RELOAD_KEY, (openings) => ({
    next: { ...asRecord(openings), [tab.id]: { ...opening, pageUrl: tab.url ?? null, createdAt: Date.now() } },
  }));
  return "deferred";
}

/// The openings an earlier worker left for this one, taken once.
function takeOpeningsAfterReload() {
  return changeStoredValue(chrome.storage.local, OPENINGS_AFTER_RELOAD_KEY,
    (openings) => ({ next: openings === undefined ? undefined : null, result: openings }));
}

/// The tab `tabId` names, or `null` when it is gone.
/** @param {number} tabId @returns {Promise<TabWithId | null>} */
async function tabStillOpen(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return hasTabId(tab) ? tab : null;
  } catch {
    return null;
  }
}

/// Whether an entry an earlier worker left is recent enough to act on.
/** @param {unknown} entry @returns {entry is Record<string, unknown>} */
function isRecentEntry(entry) {
  return isRecord(entry) && typeof entry.createdAt === "number" && Date.now() - entry.createdAt <= CLIPPER_LAUNCH_TTL_MS;
}

// The clips kept for tabs whose overlay went with its page (Ч12), carried
// across the reload, which clears session storage. They hold no update: the
// overlay that would close them is gone, and its tab may never show a page
// that asks for them, an `about:blank` or a page closed to extensions, which
// left the icon dead until a manual reload (SPEC_CLIPPER.md, К4, «Значок
// после обновления», 19.10.2026). The worker of the new build puts each back
// and opens it in its tab; a tab that cannot hold the overlay keeps it for its
// next document, as before.
const KEPT_CLIPS_AFTER_RELOAD_KEY = "mineKeptClipsAfterReload";

/// Carry every clip kept now. It replaces what an earlier carry left.
async function carryKeptClips() {
  /** @type {Record<string, { clip: KeptClip, createdAt: number }>} */
  const carried = {};
  for (const tabId of await keptClipTabs()) {
    const clip = await readOpenClip(tabId);
    if (isOpenClip(clip) && await tabStillOpen(tabId)) carried[tabId] = { clip, createdAt: Date.now() };
  }
  if (Object.keys(carried).length > 0) await chrome.storage.local.set({ [KEPT_CLIPS_AFTER_RELOAD_KEY]: carried });
  else await chrome.storage.local.remove(KEPT_CLIPS_AFTER_RELOAD_KEY);
}

/// Take back a carry whose reload did not happen: the clips are still kept in
/// session storage, and a later reload carries them again.
function dropCarriedClips() {
  return chrome.storage.local.remove(KEPT_CLIPS_AFTER_RELOAD_KEY);
}

/// The clips an earlier worker carried for this one, taken once.
async function takeCarriedClips() {
  const carried = (await chrome.storage.local.get(KEPT_CLIPS_AFTER_RELOAD_KEY))[KEPT_CLIPS_AFTER_RELOAD_KEY];
  if (carried !== undefined) await chrome.storage.local.remove(KEPT_CLIPS_AFTER_RELOAD_KEY);
  return asRecord(carried);
}

/// The launches that wait for a reload a live clipper holds. Each is told on
/// its page and dropped instead of waiting for a close that may be far off:
/// the person closes that clipper, the update applies, and the next opening
/// is made by the worker of the new build (19.10.2026). Kept clips waiting
/// for the reload stay.
async function tellOpeningsHeldByClipper() {
  const held = await changeStoredValue(chrome.storage.local, OPENINGS_AFTER_RELOAD_KEY, (stored) => {
    const openings = asRecord(stored);
    const launches = Object.keys(openings).filter((tabId) => isRecord(openings[tabId]) && openings[tabId].options !== undefined);
    if (launches.length === 0) return { result: [] };
    const rest = Object.fromEntries(Object.entries(openings).filter(([tabId]) => !launches.includes(tabId)));
    return {
      next: Object.keys(rest).length > 0 ? rest : null,
      result: launches.filter((tabId) => isRecentEntry(openings[tabId])).map(Number),
    };
  });
  await Promise.all((held ?? []).map((tabId) => tellInPage(tabId, UPDATE_WAITS_FOR_CLIPPER)));
}

/// Show `text` on the page of `tabId` for a moment. The page gets a function
/// of this worker's own code, never a file from disk, which may be of another
/// build (К4). A page closed to extensions leaves the badge to say it.
/** @param {number} tabId @param {string} text */
async function tellInPage(tabId, text) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showPageNotice, args: [text] });
  } catch (error) {
    console.warn("[Mine] the page could not show why the clipper did not open:", failureText(error));
    try {
      chrome.action.setBadgeText({ text: "ERR" });
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    } catch {
      // Badge is cosmetic; ignore if the action API is unavailable.
    }
  }
}

/// The notice `tellInPage` puts on a page: one line in the bottom right
/// corner, 16 px in from the window's edges like the overlay (Р10), read out
/// without taking the keyboard (Р5), gone after a few seconds or a click. It
/// runs in the page, so it holds everything it uses.
/** @param {string} text */
function showPageNotice(text) {
  const MARK = "data-mine-notice";
  const SHOWN_MS = 8_000;
  for (const old of document.querySelectorAll(`[${MARK}]`)) old.remove();
  const host = document.createElement("div");
  host.setAttribute(MARK, "");
  const note = document.createElement("div");
  note.setAttribute("role", "status");
  note.textContent = text;
  note.style.cssText = [
    "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647", "box-sizing:border-box",
    "max-width:min(360px,calc(100vw - 32px))", "padding:12px 14px", "border-radius:12px",
    "background:rgba(28,28,30,0.94)", "color:#fff", "font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,0.24)", "cursor:default",
  ].join(";");
  host.attachShadow({ mode: "open" }).append(note);
  host.addEventListener("click", () => host.remove());
  (document.body ?? document.documentElement).append(host);
  setTimeout(() => host.remove(), SHOWN_MS);
}

async function runOpeningsAfterReload() {
  const carried = await takeCarriedClips();
  const openings = asRecord(await takeOpeningsAfterReload());
  // A clip carried across the reload comes back first; an opening of its tab
  // below opens it, or replaces it with a launch, as without the reload.
  for (const [tabId, kept] of Object.entries(carried)) {
    if (!isRecentEntry(kept) || !isOpenClip(kept.clip)) continue;
    const tab = await tabStillOpen(Number(tabId));
    if (!tab) continue;
    await writeOpenClip(tab.id, kept.clip);
    if (tabId in openings) continue;
    // A tab that cannot hold the overlay now keeps the clip for its next
    // document (Ч12); its failure is not news.
    void restoreOpenClipInTab(tab).catch(() => undefined);
  }
  for (const [tabId, opening] of Object.entries(openings)) {
    if (!isRecentEntry(opening)) continue;
    const tab = await tabStillOpen(Number(tabId));
    if (!tab) continue;
    /** @param {unknown} error */
    const failed = (error) => console.warn("[Mine] the clipper did not open after the update:", failureText(error));
    if (isOpenClip(opening.restore)) {
      await writeOpenClip(tab.id, opening.restore);
      void restoreOpenClipInTab(tab).catch(failed);
    } else if (opening.options && (opening.pageUrl === null || tab.url === opening.pageUrl)) {
      void openClipperUi(tab, launchOptions(asRecord(opening.options))).catch(failed);
    }
  }
}

// ── Pages open before this build (SPEC_CLIPPER.md, К4 and rule 9 of «Кнопка
// Mine в ленте X») ─────────────────────────────────────────────────────────
//
// A reload or an update leaves the content scripts in open pages cut off from
// the extension: the browser does not put the new ones there. This worker
// puts the content scripts of the manifest into every open tab their matches
// name, top frame as declared, as soon as it is installed or updated. Each
// page gets them in a world of its own; the content script there before gives
// the page up (content.js). The scripts of the page's own world
// (lib/xThread.js and lib/xThreadPage.js, the post cache of X) go only into a
// page without that cache, such as a tab open before the install
// (13.10.2026): a page that has it keeps it, with the feeds it already read.

// Tabs being given the content scripts of this build, by tab, and the search
// for those tabs.
/** @type {Map<number, Promise<void>>} */
const pageRefreshes = new Map();
let pagesFound = Promise.resolve();

/// Wait while `tabId` is being given the content scripts of this build: an
/// overlay opened before them finds no content script in its world.
/** @param {number | undefined} tabId */
async function pageRefreshed(tabId) {
  await pagesFound;
  if (typeof tabId === "number") await pageRefreshes.get(tabId);
}

/// The content-script groups of the manifest this worker can put again, by
/// the open tab they belong to, each tab's in the manifest's order. A group
/// that excludes pages is left out: tabs are found by `matches` alone.
/** @returns {Promise<Map<number, PlannedGroup[]>>} */
async function contentScriptPlan() {
  /** @type {ContentScriptGroup[]} */
  const declared = chrome.runtime.getManifest?.()?.content_scripts ?? [];
  const groups = declared.filter(/** @returns {group is PlannedGroup} */ (group) =>
    ["ISOLATED", "MAIN"].includes(group.world ?? "ISOLATED") && Array.isArray(group.js) && group.js.length > 0
    && Array.isArray(group.matches) && group.matches.length > 0
    && !group.exclude_matches && !group.include_globs && !group.exclude_globs);
  /** @type {Map<number, PlannedGroup[]>} */
  const plan = new Map();
  for (const group of groups) {
    /** @type {chrome.tabs.Tab[]} */
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: group.matches });
    } catch (error) {
      console.warn("[Mine] open pages not found for the content scripts:", failureText(error));
    }
    for (const tab of tabs) {
      if (typeof tab.id !== "number" || tab.discarded) continue;
      const groupsOfTab = plan.get(tab.id) ?? [];
      groupsOfTab.push(group);
      plan.set(tab.id, groupsOfTab);
    }
  }
  return plan;
}

/// Whether every frame of `target` already runs the post cache of X in its
/// page world: lib/xThreadPage.js, the last of the manifest's page-world
/// scripts, which also refuses to run twice in one page.
/** @param {chrome.scripting.InjectionTarget} target */
async function pageWorldHasPostCache(target) {
  const frames = await chrome.scripting.executeScript({ target, world: "MAIN",
    func: () => globalThis.MineXThreadPage !== undefined });
  return frames.length > 0 && frames.every((frame) => frame?.result === true);
}

/** @param {number} tabId @param {PlannedGroup[]} groups */
async function injectContentScripts(tabId, groups) {
  for (const group of groups) {
    const target = { tabId, allFrames: group.all_frames === true };
    try {
      if (group.world === "MAIN") {
        if (!(await pageWorldHasPostCache(target))) {
          await chrome.scripting.executeScript({ target, world: "MAIN", files: group.js });
        }
      } else {
        await chrome.scripting.executeScript({ target, files: group.js });
      }
    } catch {
      // A page the browser keeps extensions out of (the extension store, a
      // file without file access, an error page), or a tab gone meanwhile.
      return;
    }
  }
}

/// Give every open page the content scripts of this build. Files of another
/// build on disk wait for the reload into it, whose worker does this.
function refreshOpenPages() {
  const found = (async () => {
    if ((await filesOfRunningBuild()) !== "same") return [];
    const plan = await contentScriptPlan();
    return [...plan].map(([tabId, groups]) => {
      const refresh = injectContentScripts(tabId, groups);
      pageRefreshes.set(tabId, refresh);
      void refresh.then(() => {
        if (pageRefreshes.get(tabId) === refresh) pageRefreshes.delete(tabId);
      });
      return refresh;
    });
  })();
  pagesFound = found.then(() => undefined, () => undefined);
  return found.then((refreshes) => Promise.all(refreshes));
}

// An opening left by the worker before the reload waits for its own tab only.
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== "install" && details?.reason !== "update") return;
  void refreshOpenPages()
    .catch((error) => console.warn("[Mine] open pages kept their content scripts:", failureText(error)));
  void pagesFound.then(() => runOpeningsAfterReload())
    .catch((error) => console.warn("[Mine] openings after the update dropped:", failureText(error)));
});

// ── Context menus ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-page",
    title: "Save page to Mine",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "save-image",
    title: "Save image to Mine",
    contexts: ["image"],
  });

  chrome.contextMenus.create({
    id: "save-selection",
    title: "Save selection to Mine",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "save-link",
    title: "Save link to Mine",
    contexts: ["link"],
  });

});

/** @param {chrome.contextMenus.OnClickData} info @param {chrome.tabs.Tab | undefined} tab */
async function handleContextMenuClick(info, tab) {
  // The clicked target travels with this opening only (Ф6); useClipperState
  // reads it through getClipperLaunch and applies it to the metadata.
  /** @type {import("./popup/lib/messaging").ContextMenuData} */
  const context = {
    menuItemId: info.menuItemId,
    srcUrl: info.srcUrl || null,
    linkUrl: info.linkUrl || null,
    selectionText: info.selectionText || null,
    pageUrl: info.pageUrl || tab?.url || null,
    frameUrl: info.frameUrl || null,
  };
  await openClipperUi(tab, { fallbackUrl: bestContextMenuPageUrl(info, tab), contextMenu: context });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch((e) => {
    console.error("[Mine] context menu click failed:", e);
  });
});

// ── Native messaging ──────────────────────────────────────────────────────

// Send a message to the native host and return the response.
// Uses connectNative for persistent connection within a session.
// Responses must match the echoed messageId; no FIFO acknowledgement of saves.
/** @type {chrome.runtime.Port | null} */
let nativePort = null;
// What the helper on `nativePort` declared in its status (`features`).
/** @type {Set<unknown> | null} */
let nativePortFeatures = null;
/**
 * A request waiting for the helper's answer: `restart` starts a Save's
 * deadline again on a sign of work.
 * @typedef {{ resolve: (reply: HostReply) => void, timeout: ReturnType<typeof setTimeout>, action: unknown, restart: (() => void) | null }} PendingCall
 */
/** @type {Map<number, PendingCall>} */
const pendingCallbacks = new Map();
let messageId = 0;
/** @type {Map<string, { dataUrl: string, contentType: string, createdAt: number }>} */
const screenshotUploads = new Map();
let screenshotUploadId = 0;

/** @param {unknown} dataUrl @returns {{ ok: true, screenshotId: string } | { ok: false, error: string }} */
function cacheScreenshotUpload(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return { ok: false, error: "Missing screenshot data" };
  }

  const id = `shot-${Date.now()}-${++screenshotUploadId}`;
  const mimeMatch = /^data:([^;,]+)/.exec(dataUrl);
  screenshotUploads.set(id, {
    dataUrl,
    contentType: mimeMatch?.[1] ?? "image/jpeg",
    createdAt: Date.now(),
  });

  // Keep the cache bounded to live clipper interactions.
  if (screenshotUploads.size > 8) {
    const oldest = [...screenshotUploads.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .slice(0, screenshotUploads.size - 8);
    for (const [oldId] of oldest) screenshotUploads.delete(oldId);
  }

  return { ok: true, screenshotId: id };
}

function getNativePort() {
  if (nativePort) return nativePort;

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    // No helper is registered for this browser: the request answers
    // `native_unavailable`.
    return null;
  }

  const port = nativePort;
  nativePortFeatures = null;
  port.onMessage.addListener((/** @type {unknown} */ msg) => {
    // The helper answers objects; anything else matches no request.
    if (!isRecord(msg)) {
      console.warn("[Mine] Ignored uncorrelated native response");
      return;
    }
    if (msg.code === "host_replaced") {
      retireReplacedHost(port, msg);
      return;
    }
    const id = msg._messageId;
    const pending = typeof id === "number" ? pendingCallbacks.get(id) : undefined;
    // A sign that the helper still works on a Save: its deadline starts
    // again. Never an answer (SPEC_DEEP_AUDIT.md, Н9).
    if (msg.progress === true) {
      pending?.restart?.();
      return;
    }
    if (typeof id === "number" && pending) {
      const { resolve, timeout, action } = pending;
      pendingCallbacks.delete(id);
      clearTimeout(timeout);
      resolve(msg);
      if (action === "get_status") {
        if (nativePort === port && Array.isArray(msg.features)) nativePortFeatures = new Set(msg.features);
        confirmNativeConnection(msg, port);
        void noteInstalledExtension(msg).catch(() => undefined);
      }
      if (action === "save_block") scheduleReloadCheck();
    } else {
      // An uncorrelated or late response must never acknowledge another save.
      console.warn("[Mine] Ignored uncorrelated native response");
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected";
    for (const [, { resolve, timeout }] of pendingCallbacks) {
      clearTimeout(timeout);
      resolve({ ok: false, error, code: "native_disconnected", outcome: "unknown" });
    }
    pendingCallbacks.clear();
    nativePort = null;
    nativePortFeatures = null;
  });

  return nativePort;
}

// ── Extension update (SPEC_CLIPPER.md, К4) ───────────────────────────────
//
// A browser keeps running the extension it loaded until someone presses
// Reload. The helper reports the build installed on disk; when it differs
// from this one, the extension reloads itself once the clipper is closed and
// no save is waiting for an answer. One reload per installed build: if the
// browser loads another folder than the one updated, the extension does not
// reload in a loop. Only a live clipper holds the reload, and an opening it
// holds is told so on its page: an opening that waits for the reload while the
// reload waits for a clipper nobody can close left the icon dead
// (19.10.2026).
//
// The running build is the one written into this worker's code: the extension
// build puts it into dist/build-identity.js, imported when the worker starts.
// The browser keeps a worker's code, imported files included, until the
// extension reloads, even across worker restarts. A file read now (fetch)
// answers the copy on disk, which an update has already replaced, so it would
// name the new build and the update would never apply (12.10.2026). The same
// comparison, with the build the files on disk name, keeps every file read
// from disk to the running build (lib/extensionBuild.js, 13.10.2026).
function runningBuild() {
  return globalThis.MineExtensionBuild.running();
}

/** @param {HostReply} status */
async function noteInstalledExtension(status) {
  await globalThis.MineExtensionBuild.noteInstalled(status.extension_build_id);
}

async function reloadIfUpdated() {
  const activity = clipperActivity;
  const { mineReloadPending } = await chrome.storage.session.get("mineReloadPending");
  if (typeof mineReloadPending !== "string") return;
  // A save in flight finishes first; its end checks again.
  if (reloadWaits(activity)) return;
  // Closing one clipper must not take away another one still open. The
  // openings waiting for the reload are told so on their page (19.10.2026).
  if (await anyEditorOpen()) {
    await tellOpeningsHeldByClipper();
    return;
  }
  if (reloadWaits(activity)) return;
  await carryKeptClips();
  const { mineReloadedFor } = await chrome.storage.local.get("mineReloadedFor");
  await chrome.storage.local.set({ mineReloadedFor: mineReloadPending });
  await chrome.storage.session.remove("mineReloadPending");
  // Checked again with nothing awaited before the reload: a clipper opened,
  // a browser write begun or a save sent while the tabs were asked or storage
  // written would be cut off. The update stays pending, and the end of that
  // work checks again (SPEC_AUDIT_FIXES.md, В4.6). The reload did not happen:
  // an opening meanwhile must find it pending, not refused as one that
  // happened and failed (19.10.2026).
  if (reloadWaits(activity)) {
    await chrome.storage.session.set({ mineReloadPending });
    if (mineReloadedFor === undefined) await chrome.storage.local.remove("mineReloadedFor");
    else await chrome.storage.local.set({ mineReloadedFor });
    await dropCarriedClips();
    return;
  }
  // Chromium loads an unpacked extension again only while developer mode is
  // on, and an extension cannot read that switch. With it off the extension
  // stays installed but disabled, its storage kept, until developer mode is
  // turned on (checked in Chromium 148 on 13.10.2026, К4).
  chrome.runtime.reload();
}

// Writes into the folder chosen in the browser, a clip and a new collection,
// run inside this worker; a reload would cut them off half written
// (SPEC_CLIPPER.md, К4).
let browserWritesInFlight = 0;
// Clipper openings still under way, and a count of every opening and every
// browser write begun. A reload check that saw this count change while it
// waited has seen a clipper that it did not ask about (В4.6).
let clipperOpeningsInFlight = 0;
let clipperActivity = 0;

/// Whether a pending update has to wait: a write or an opening under way, a
/// save waiting for the helper, or any of them begun since `activity`.
/** @param {number} activity */
function reloadWaits(activity) {
  if (browserWritesInFlight > 0 || clipperOpeningsInFlight > 0 || clipperActivity !== activity) return true;
  for (const [, pending] of pendingCallbacks) {
    if (pending.action === "save_block") return true;
  }
  return false;
}

/** @template T @param {() => T | PromiseLike<T>} work @returns {Promise<T>} */
function trackBrowserWrite(work) {
  browserWritesInFlight += 1;
  clipperActivity += 1;
  return Promise.resolve()
    .then(work)
    .finally(() => {
      browserWritesInFlight -= 1;
      scheduleReloadCheck();
    });
}

/// An opening of the clipper holds a pending update until it has finished;
/// the clipper it opened then holds it until it closes.
/** @template T @param {() => T | PromiseLike<T>} work @returns {Promise<T>} */
function trackClipperOpening(work) {
  clipperOpeningsInFlight += 1;
  clipperActivity += 1;
  return Promise.resolve()
    .then(work)
    .finally(() => {
      clipperOpeningsInFlight -= 1;
      scheduleReloadCheck();
    });
}

// Check again once the answer has reached the page: a pending update waits
// for the save, not for the next time a clipper happens to close. A burst of
// writes schedules one check after the last of them.
const RELOAD_CHECK_DELAY_MS = 1000;
/** @type {ReturnType<typeof setTimeout> | null} */
let reloadCheckTimer = null;
function scheduleReloadCheck() {
  if (reloadCheckTimer !== null) clearTimeout(reloadCheckTimer);
  reloadCheckTimer = setTimeout(() => {
    reloadCheckTimer = null;
    void reloadIfUpdated().catch((error) => console.warn("[Mine] extension reload failed:", failureText(error)));
  }, RELOAD_CHECK_DELAY_MS);
}

// The tabs whose overlay has a clip kept for its next document (Ч12).
const OPEN_CLIP_TABS_KEY = "mineOpenClipTabs";

/** @returns {Promise<number[]>} */
async function keptClipTabs() {
  const tabs = (await chrome.storage.session.get(OPEN_CLIP_TABS_KEY))[OPEN_CLIP_TABS_KEY];
  return asList(tabs).filter((tabId) => typeof tabId === "number");
}

// Whether a clipper is open anywhere: an extension page (the window used where
// the overlay cannot run, the folder setup page) or an overlay that says so in
// its tab, hidden for a screenshot or a crop or still mounting included. A
// browser that cannot list extension pages is treated as having one open. A
// clip kept for a tab is no open clipper by itself: its overlay went with the
// page, and the clip crosses the reload (`carryKeptClips`, 19.10.2026).
async function anyEditorOpen() {
  if (typeof chrome.runtime.getContexts !== "function") return true;
  const pages = await chrome.runtime.getContexts({ contextTypes: ["TAB", "POPUP", "SIDE_PANEL"] });
  if (pages.length > 0) return true;
  const keeping = new Set(await keptClipTabs());
  const tabs = await chrome.tabs.query({});
  const answers = await Promise.all(tabs.map((tab) => (typeof tab.id !== "number"
    ? false
    : overlayOpenIn(tab.id, keeping.has(tab.id)))));
  return answers.some(Boolean);
}

// A tab's overlay answers at once. One that has not answered by then cannot
// be asked: a frozen or hung page. It holds a pending update only while a clip
// is kept for it, whose overlay may still be there (19.10.2026).
const OVERLAY_ANSWER_TIMEOUT_MS = 2_000;

/// Whether the overlay in `tabId` says it is open; `keepsClip` is the answer of
/// a tab that does not answer in time.
/** @param {number} tabId @param {boolean} keepsClip @returns {Promise<boolean>} */
function overlayOpenIn(tabId, keepsClip) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let late;
  /** @type {Promise<boolean>} */
  const unanswered = new Promise((resolve) => {
    late = setTimeout(() => resolve(keepsClip), OVERLAY_ANSWER_TIMEOUT_MS);
  });
  /** @type {Promise<boolean>} */
  const answered = chrome.tabs.sendMessage(tabId, { action: "mineClipperIsOpen" }, { frameId: 0 })
    .then((/** @type {unknown} */ answer) => isRecord(answer) && answer.open === true, () => false);
  return Promise.race([answered, unanswered]).finally(() => clearTimeout(late));
}

// A newer helper was installed while this connection stayed open (К4). The
// old process answers `host_replaced` to the first request it reads and ends
// without acting on it. Every request still waiting goes again, once, to the
// new helper: one the old helper never read, and a Save it had already begun,
// which the operation journal answers with the same receipt rather than a
// second card.
/** @param {chrome.runtime.Port} port @param {HostReply} reply */
function retireReplacedHost(port, reply) {
  if (nativePort === port) nativePort = null;
  try {
    port.disconnect();
  } catch {
    // The process may already be gone.
  }
  // Resending registers new callbacks: settle a snapshot of the old ones.
  const waiting = [...pendingCallbacks.values()];
  pendingCallbacks.clear();
  for (const { resolve, timeout } of waiting) {
    clearTimeout(timeout);
    resolve(reply);
  }
}

// A Save waits as long as the helper works: a helper that declares
// `save_progress_v1` sends a sign of work at most every 5 s while bytes keep
// arriving and steps keep ending, and the deadline counts from the last sign
// (SPEC_DEEP_AUDIT.md, Н9). A 500 MiB video (net.rs, MAX_MEDIA_BYTES) on a
// slow link is never cut off while its bytes come; a stalled download read
// ends at 15 s in the helper and its failure is a sign too. A helper that
// sends no signs keeps the former three minutes from the start.
const SAVE_IDLE_TIMEOUT_MS = 60_000;
const LEGACY_SAVE_TIMEOUT_MS = 180_000;

/** @param {unknown} action */
function timeoutForAction(action) {
  if (action === "save_block") {
    return nativePortFeatures?.has("save_progress_v1") ? SAVE_IDLE_TIMEOUT_MS : LEGACY_SAVE_TIMEOUT_MS;
  }
  // The folder chooser waits on a human, not on IPC.
  if (action === "pick_vault_folder") return 300_000;
  return 30_000;
}

/** @param {HostReply} status @param {chrome.runtime.Port} port */
function confirmNativeConnection(status, port) {
  if (status.ok !== true || status.connected !== true ||
      !Array.isArray(status.features) || !status.features.includes("connection_check_v1")) return;
  // ACK proves receipt of this response on the same connection, not a new host.
  // Its optional failure never delays or alters the returned status/capture.
  void sendNativeMessage({
    action: "confirm_connection_check",
    check_id: crypto.randomUUID(),
  }, port).then((result) => {
    if (!result.ok) console.warn("[Mine] Connection-check acknowledgement was not recorded");
  });
}

/// Send `message`, the request as the clipper made it, to the helper.
/**
 * @param {unknown} message
 * @param {chrome.runtime.Port | null} [expectedPort]
 * @param {boolean} [afterReplacement]
 * @returns {Promise<HostReply>}
 */
function sendNativeMessage(message, expectedPort = null, afterReplacement = false) {
  return new Promise((settle) => {
    // The replaced helper did nothing with the request: it goes once to the
    // new helper. A check bound to the old connection has nothing to confirm.
    /** @param {HostReply} reply */
    const resolve = (reply) => settle(reply.code === "host_replaced" && !expectedPort && !afterReplacement
      ? sendNativeMessage(message, null, true)
      : reply);
    const port = expectedPort
      ? (nativePort === expectedPort ? expectedPort : null)
      : getNativePort();
    if (!port) {
      resolve({
        ok: false,
        error: "Cannot start the Mine helper. Open Mine once to register it, then retry the connection.",
        code: "native_unavailable",
        outcome: "not_committed",
      });
      return;
    }

    const id = ++messageId;
    // A request that is no object carries no fields, as spreading it did.
    const request = isRecord(message) ? message : {};
    const action = request.action;
    const isSave = action === "save_block";

    const expire = () => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        resolve({ ok: false, error: "Mine helper did not respond in time", code: "native_timeout", outcome: "unknown" });
      }
    };
    /** @type {PendingCall} */
    const entry = { resolve, timeout: setTimeout(expire, timeoutForAction(action)), action, restart: null };
    // Each sign of work starts the Save's deadline again (Н9).
    if (isSave) {
      entry.restart = () => {
        clearTimeout(entry.timeout);
        entry.timeout = setTimeout(expire, SAVE_IDLE_TIMEOUT_MS);
      };
    }
    pendingCallbacks.set(id, entry);

    try {
      // A Save asks for signs of work; a helper that does not know them
      // ignores the field, and an older one never sends what this one
      // would take for an answer.
      port.postMessage(isSave ? { ...request, _progress: true, _messageId: id } : { ...request, _messageId: id });
    } catch (error) {
      clearTimeout(entry.timeout);
      pendingCallbacks.delete(id);
      resolve({ ok: false, error: failureText(error), code: "native_disconnected", outcome: "unknown" });
    }
  });
}

/** @param {unknown} tag */
async function broadcastChannelsChanged(tag) {
  return broadcastClipperMessage({ action: "mineChannelsChanged", tag: tag ?? null });
}

/** @param {Record<string, unknown>} message */
async function broadcastClipperMessage(message) {

  // Detached popup windows are extension pages, so runtime messaging reaches
  // them. In-page overlays are content scripts; Chrome requires tabs messaging
  // for those contexts.
  try {
    const runtimeSend = chrome.runtime.sendMessage(message);
    if (runtimeSend && typeof runtimeSend.catch === "function") {
      runtimeSend.catch(() => {});
    }
  } catch {
    // Best-effort broadcast: no receiver (popup closed) is an expected no-op.
  }

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !isContentScriptCompatible(tab.url)) continue;
      chrome.tabs.sendMessage(tab.id, message, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch {
    // Best-effort broadcast: a tab with no content-script listener is expected.
  }
}

/** @param {chrome.runtime.MessageSender} sender */
async function ensureDefuddleInjected(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { ok: false, error: "No sender tab" };
  }

  const target = typeof sender.frameId === "number" && Number.isInteger(sender.frameId)
    ? { tabId, frameIds: [sender.frameId] }
    : { tabId };

  // Defuddle is read from disk (К4). The clipper that asks is open, so the
  // reload into the build on disk waits for it to close; the page is read
  // without Defuddle meanwhile.
  if ((await filesOfRunningBuild()) !== "same") {
    return { ok: false, code: "extension_updated", error: EXTENSION_UPDATED };
  }

  // Defuddle bundles Temml, which warns at module-load time on quirks-mode
  // pages. The warning is noisy extension UI, not a Mine user-facing problem.
  // Suppress only that known vendor warning while loading the vendor bundle.
  await chrome.scripting.executeScript({
    target,
    func: () => {
      if (globalThis.__mineRestoreDefuddleConsole) return;
      const originalWarn = console.warn.bind(console);
      globalThis.__mineRestoreDefuddleConsole = () => {
        console.warn = originalWarn;
        delete globalThis.__mineRestoreDefuddleConsole;
      };
      console.warn = (...args) => {
        const message = String(args[0] ?? "");
        if (message.includes("Temml doesn't work in quirks mode")) return;
        originalWarn(...args);
      };
    },
  });

  try {
    await chrome.scripting.executeScript({
      target,
      files: ["lib/defuddle.js"],
    });
  } finally {
    await chrome.scripting.executeScript({
      target,
      func: () => {
        globalThis.__mineRestoreDefuddleConsole?.();
      },
    });
  }

  return { ok: true };
}

/// Upload a cached screenshot to the helper's local upload server; `payload`
/// is the request as the clipper sent it.
/** @param {unknown} payload @returns {Promise<unknown>} */
async function uploadFileToNativeHost(payload) {
  const { port, token, filename, screenshotId, vaultPath } = asRecord(payload);
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: "Invalid upload port" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, error: "Missing upload token" };
  }
  if (typeof filename !== "string" || filename.length === 0) {
    return { ok: false, error: "Missing upload filename" };
  }
  if (typeof screenshotId !== "string" || screenshotId.length === 0) {
    return { ok: false, error: "Missing screenshot id" };
  }

  const cached = screenshotUploads.get(screenshotId);
  if (!cached) {
    return { ok: false, error: "Screenshot upload expired" };
  }

  try {
    const blob = await fetch(cached.dataUrl).then((response) => response.blob());
    const params = new URLSearchParams({ filename });
    if (typeof vaultPath === "string" && vaultPath.length > 0) {
      params.set("vault_path", vaultPath);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let resp;
    try {
      resp = await fetch(
        `http://127.0.0.1:${port}/upload?${params.toString()}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": cached.contentType || blob.type || "application/octet-stream",
          },
          body: blob,
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    /** @type {unknown} */
    const result = await resp.json();
    if (isRecord(result) && result.ok) screenshotUploads.delete(screenshotId);
    return result;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


// ── Authenticated tweet video ─────────────────────────────────────────────
//
// Age-restricted posts are invisible to the public syndication API — it returns
// a tombstone to anonymous callers — and their video sits behind a `blob:` URL
// in the page, so neither the API nor DOM scraping can reach it. The one thing
// that can is the session already logged in here.
//
// Cookies are read only for x.com, only when a tweet turned out to have video
// the other paths could not resolve, and are handed straight to the native host
// for a single yt-dlp call. They are never stored.
/** @param {unknown} payload @returns {Promise<HostReply>} */
async function resolveAuthenticatedTweetVideo(payload) {
  const { tweetUrl, tweetId } = asRecord(payload);
  if (!tweetUrl && !tweetId) return { ok: false, error: "tweet reference missing" };

  const jar = [];
  for (const domain of ["x.com", "twitter.com"]) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies) jar.push({ name: cookie.name, value: cookie.value });
    } catch (err) {
      console.warn("[Mine] could not read cookies for", domain, err);
    }
  }
  console.log("[Mine] authenticated video: cookies", jar.length, "for", tweetUrl ?? tweetId);
  if (jar.length === 0) return { ok: false, error: "no session cookies for x.com" };

  return sendNativeMessage({
    action: "resolve_twitter_media",
    url: tweetUrl ?? null,
    tweet_id: tweetId ?? null,
    cookies: jar,
  });
}

// ── Syndication answer of an X post ───────────────────────────────────────
//
// The fallback of an X post its page's feeds did not deliver and of a post
// page without collected thread data (SPEC_CLIPPER.md, «Кнопка Mine в ленте
// X», rule 6). The service answers only the origin of X's embed widget
// (`access-control-allow-origin: https://platform.twitter.com`), so a request
// from a content script or the overlay, which goes with the page's origin,
// always fails on CORS (13.10.2026). Asked here, it goes by the extension's
// host permissions. Without cookies; the asker reads the answer. Any failure
// answers `{ ok: false }`.
const X_SYNDICATION_TIMEOUT_MS = 10_000;

/** @param {unknown} tweetId */
async function readXSyndication(tweetId) {
  if (typeof tweetId !== "string" || !/^\d{1,25}$/.test(tweetId)) return { ok: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X_SYNDICATION_TIMEOUT_MS);
  try {
    const response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`,
      { credentials: "omit", signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status };
    /** @type {unknown} */
    const data = await response.json();
    return data !== null && typeof data === "object" && !Array.isArray(data) ? { ok: true, data } : { ok: false };
  } catch (error) {
    console.warn("[Mine] X post unavailable from syndication:", failureText(error));
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

// ── YouTube channel ───────────────────────────────────────────────────────
//
// The author of a YouTube clip is the channel of the video its address names
// (SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube»). oEmbed answers for
// exactly that video id; the page's markup may still describe the video shown
// before an in-page navigation. Asked here, where <all_urls> reaches YouTube
// from any page host, and without cookies. Any failure answers no channel:
// the clip is saved without an author.
/** @param {unknown} sourceUrl */
async function resolveYoutubeChannel(sourceUrl) {
  const youtube = globalThis.MineYoutubeSource;
  const endpoint = youtube.youtubeOEmbedUrl(sourceUrl);
  if (!endpoint) return { channel: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), youtube.YOUTUBE_CHANNEL_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, { credentials: "omit", signal: controller.signal });
    if (!response.ok) return { channel: null };
    return { channel: youtube.youtubeChannelFromOEmbed(await response.json()) };
  } catch (error) {
    console.warn("[Mine] YouTube channel unavailable:", failureText(error));
    return { channel: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Message handler (from popup) ──────────────────────────────────────────

/** @param {unknown} error */
function extensionBackgroundFailure(error) {
  return {
    ok: false,
    error: failureText(error),
    code: "extension_background_error",
    outcome: "unknown",
  };
}

// Chromium APIs return Promises, while Dia versions of the same APIs may only
// invoke callbacks. Supplying both completion paths is safe as long as the
// response channel is settled exactly once.
/**
 * @param {(response: unknown) => void} sendResponse
 * @param {(callback: () => void) => PromiseLike<unknown> | void} invoke
 */
function respondToBrowserCreate(sendResponse, invoke) {
  let answered = false;
  /** @param {unknown} response */
  const answer = (response) => {
    if (answered) return;
    answered = true;
    sendResponse(response);
  };
  const callback = () => {
    const runtimeError = chrome.runtime.lastError;
    answer(runtimeError ? extensionBackgroundFailure(runtimeError) : { ok: true });
  };

  try {
    const pending = invoke(callback);
    if (pending && typeof pending.then === "function") {
      pending.then(
        () => answer({ ok: true }),
        (error) => answer(extensionBackgroundFailure(error)),
      );
    }
  } catch (error) {
    answer(extensionBackgroundFailure(error));
  }
}

// The in-flight map coalesces clicks. Existing browser windows remain the
// source of truth after a service worker restart.
/** @type {Map<string, Promise<{ ok: boolean }>>} */
const folderSetupRequests = new Map();
/**
 * @template T
 * @param {(callback: (value: T) => void) => PromiseLike<T> | void} invoke
 * @returns {Promise<T>}
 */
function browserCall(invoke) {
  return new Promise((resolve, reject) => {
    try {
      const pending = invoke((value) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(value);
      });
      if (pending && typeof pending.then === "function") pending.then(resolve, reject);
    } catch (error) { reject(error); }
  });
}
/** @param {string} url */
function openFolderSetup(url) {
  const requested = folderSetupRequests.get(url);
  if (requested) return requested;
  const operation = (async () => {
    /** @type {chrome.windows.Window[]} */
    const windows = await browserCall(callback => chrome.windows.getAll({ populate: true }, callback));
    const existing = windows.find(window => window.tabs?.some(tab => tab.url === url))?.id;
    if (existing !== undefined) {
      await browserCall(callback => chrome.windows.update(existing, { focused: true }, callback));
    } else {
      await browserCall(callback => chrome.windows.create({ url, type: "popup", width: 420, height: 280, focused: true }, callback));
    }
    return { ok: true };
  })();
  folderSetupRequests.set(url, operation);
  operation.finally(() => folderSetupRequests.delete(url)).catch(() => {});
  return operation;
}

chrome.runtime.onMessage.addListener((/** @type {unknown} */ message, sender, sendResponse) => {
  // A message is an object its sender wrote; anything else is not for here.
  if (!isRecord(message) || message.target !== "background") return false;
  const msg = message;

  if (msg.action === "collectXThread") {
    const source = sender.url || sender.tab?.url || "";
    const match = source.match(/^https:\/\/(?:x\.com|pro\.x\.com|twitter\.com)\/[^/]+\/status\/(\d+)(?:[/?#]|$)/);
    if (!match || typeof msg.tweetId !== "string" || match[1] !== msg.tweetId || sender.tab?.id === undefined || sender.frameId !== 0) {
      sendResponse({ posts: [], issues: ["Open the original X post to collect its thread."] });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [0] }, world: "MAIN",
      func: async (id) => globalThis.MineXThreadPage
        ? globalThis.MineXThreadPage.collect(id)
        : { posts: [], issues: ["Reload this X page once, then open Mine again to collect the thread."] },
      args: [msg.tweetId],
    }).then(results => sendResponse(results[0]?.result || { posts: [], issues: ["No thread data returned."] }))
      .catch(() => sendResponse({ posts: [], issues: ["Thread extraction failed. Reload the page and retry."] }));
    return true;
  }

  // The Mine button of a post in an X feed or X Pro column asks for the post
  // the page's feeds delivered (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»,
  // rules 6 and 8). Only X itself asks, from its top frame.
  if (msg.action === "readXPost") {
    if (!isXPageSender(sender) || typeof msg.tweetId !== "string" || !/^\d{1,25}$/.test(msg.tweetId)) {
      sendResponse({ post: null });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [0] }, world: "MAIN",
      func: async (id) => globalThis.MineXThreadPage?.post ? globalThis.MineXThreadPage.post(id) : null,
      args: [msg.tweetId],
    }).then(results => sendResponse({ post: results?.[0]?.result ?? null }))
      .catch(() => sendResponse({ post: null }));
    return true;
  }

  // The syndication answer of an X post, for the content script and the
  // clipper, wherever they run: an anonymous read by ID (rule 6).
  if (msg.action === "readXSyndication") {
    readXSyndication(msg.tweetId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "openStandaloneSetup") {
    const url = new URL(chrome.runtime.getURL("dist/index.html?mode=setup"));
    if (typeof msg.binding_id === "string") url.searchParams.set("binding_id", msg.binding_id);
    // The setup page is read from disk (К4); the clipper that asks is open,
    // and the reload into the build on disk waits for it to close.
    filesOfRunningBuild()
      .then((files) => files === "same" ? openFolderSetup(url.href) : { ok: false, code: "extension_updated", error: EXTENSION_UPDATED })
      .then(sendResponse, error => sendResponse(extensionBackgroundFailure(error)));
    return true;
  }

  if (msg.action === "standaloneAccessRestored") {
    if (sender.url?.split("?")[0] !== chrome.runtime.getURL("dist/index.html") || typeof msg.binding_id !== "string") {
      sendResponse({ ok: false, error: "Restore access in the Mine extension window" });
      return false;
    }
    // Recovery must not replace the selected folder or an operation's binding.
    broadcastClipperMessage({ action: "mineStandaloneAccessRestored", binding_id: msg.binding_id })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "standaloneFolderChanged") {
    // Only our setup page can publish a newly granted extension-origin handle.
    if (sender.url?.split("?")[0] !== chrome.runtime.getURL("dist/index.html")) {
      sendResponse({ ok: false, error: "Folder setup must run in the Mine extension window" });
      return false;
    }
    globalThis.MineStandaloneVault.getStandaloneStatus().then(async (status) => {
      if (!status.configured || status.permission !== "granted" || !status.bindingId) {
        sendResponse({ ok: false, error: status.error ?? "Folder write access is not confirmed" });
        return;
      }
      await chrome.storage.local.set({ mineSaveDestination: { executor: "browser", bindingId: status.bindingId } });
      await broadcastClipperMessage({ action: "mineStandaloneFolderChanged" });
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  // The clipper overlay closed: the moment an update can apply (К4).
  if (msg.action === "mineClipperClosed") {
    void reloadIfUpdated().catch((error) => console.warn("[Mine] extension reload failed:", failureText(error)));
    return false;
  }

  if (msg.action === "openDownloadPage") {
    respondToBrowserCreate(sendResponse, (callback) => chrome.tabs.create(
      { url: "https://github.com/i-iii4/Mine/releases" },
      callback,
    ));
    return true;
  }

  if (msg.action === "clipperHandshake") {
    const supported = Array.isArray(msg.save_protocols) && msg.save_protocols.includes(1)
      && !globalThis.MineSaveProtocol.validate({ required_capabilities: msg.required_capabilities });
    // The build of the running worker, not of the copy on disk (К4).
    const identity = runningBuild() ?? { buildId: "unbuilt", commit: "unknown" };
    sendResponse({ ok: supported, save_protocols: [1], features: ["save_operation_v1", "operation_lookup_v1"],
      build_id: identity.buildId, commit: identity.commit,
      ...(supported ? {} : { code: "incompatible_protocol", error: "This Mine widget uses an unsupported protocol. Reload the page to open the current widget." }) });
    return false;
  }

  if (msg.action === "nativeMessage") {
    const request = isRecord(msg.payload) ? msg.payload : undefined;
    try {
      sendNativeMessage(msg.payload).then((response) => {
        if (response.ok && request?.action === "create_channel") {
          void broadcastChannelsChanged(response.tag ?? request.tag ?? null);
        } else if (response.ok && request?.action === "save_block" && request.tags) {
          void broadcastChannelsChanged(null);
        }
        sendResponse(response);
      }, (error) => sendResponse(extensionBackgroundFailure(error)));
    } catch (error) {
      sendResponse(extensionBackgroundFailure(error));
    }
    return true; // async response
  }

  // Standalone road (О1–О4): the same requests the native host serves,
  // answered from the granted folder instead. The popup decides which road a
  // request takes; background only executes.
  if (msg.action === "standaloneStatus") {
    globalThis.MineStandaloneVault.getStandaloneStatus().then(sendResponse,
      (error) => sendResponse({ configured: false, error: failureText(error) }));
    return true;
  }

  if (msg.action === "standaloneLookup") {
    const operationId = msg.operation_id;
    const bindingId = msg.binding_id;
    // The clipper names both; a request without them asks about nothing.
    if (typeof operationId !== "string" || typeof bindingId !== "string") {
      sendResponse({ ok: false, outcome: "unknown", error: "The lookup names no operation or folder" });
      return false;
    }
    globalThis.MineStandaloneVault.lookupOperation(operationId, bindingId).then(sendResponse,
      (error) => sendResponse({ ok: false, outcome: "unknown", error: failureText(error) }));
    return true;
  }

  if (msg.action === "standaloneSave") {
    // The save core validates every field; a payload that is no object
    // carries none, as `?? {}` and spreading it did.
    const payload = isRecord(msg.payload) ? msg.payload : {};
    trackBrowserWrite(() => globalThis.MineStandaloneVault.saveStandaloneBlock(payload)).then((response) => {
      if (response?.ok && payload.tags) {
        void broadcastChannelsChanged(null);
      }
      sendResponse(response);
    }, (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  if (msg.action === "standaloneListChannels") {
    globalThis.MineStandaloneVault.listStandaloneChannels().then(
      sendResponse,
      (error) => sendResponse({ ok: false, error: failureText(error) }),
    );
    return true;
  }

  if (msg.action === "standaloneCreateChannel") {
    const tag = msg.tag;
    const bindingId = msg.binding_id ?? null;
    // The clipper names the collection, and the folder by its binding or not
    // at all.
    if (typeof tag !== "string" || (bindingId !== null && typeof bindingId !== "string")) {
      sendResponse({ ok: false, outcome: "not_committed", error: "The request names no collection" });
      return false;
    }
    trackBrowserWrite(() => globalThis.MineStandaloneVault.createStandaloneChannel(tag, bindingId)).then((response) => {
      if (response?.ok) void broadcastChannelsChanged(response.tag ?? null);
      sendResponse(response);
    }, (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  if (msg.action === "resolveAuthenticatedTweetVideo") {
    resolveAuthenticatedTweetVideo(msg.payload ?? {}).then(sendResponse);
    return true; // async response
  }

  if (msg.action === "resolveYoutubeChannel") {
    resolveYoutubeChannel(msg.sourceUrl).then(sendResponse, () => sendResponse({ channel: null }));
    return true; // async response
  }

  if (msg.action === "uploadFile") {
    uploadFileToNativeHost(msg.payload ?? {}).then(sendResponse);
    return true;
  }

  if (msg.action === "cacheScreenshotUpload") {
    sendResponse(cacheScreenshotUpload(msg.dataUrl));
    return true;
  }

  if (msg.action === "ensureDefuddle") {
    ensureDefuddleInjected(sender).then(
      (response) => sendResponse(response),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }

  // Content script asks background to show the overlay in its own tab.
  // Used by the Instagram feed clip button, which has already read the post:
  // the data travels in this message and is kept for this tab's opening only.
  // This path is overlay-only: the page-injected button must not silently
  // open a detached popup window.
  if (msg.action === "showOverlayInThisTab") {
    const tab = sender.tab;
    if (!hasTabId(tab)) {
      sendResponse({ ok: false, error: "No sender tab" });
      return true;
    }
    openClipperUi(tab, {
      fallbackUrl: typeof msg.pageUrl === "string" ? msg.pageUrl : null,
      allowWindowFallback: false,
      preloaded: msg.preloaded ?? null,
    }).then(
      (mode) => sendResponse({ ok: mode === "overlay", mode }),
      async (err) => {
        // The post read for a clipper that never opened is not kept for
        // the next one.
        await forgetClipperLaunch(tab.id).catch(() => undefined);
        sendResponse({ ok: false, error: String(err) });
      },
    );
    return true;
  }

  if (msg.action === "getClipperLaunch") {
    takeClipperLaunch(sender).then(sendResponse, () => sendResponse(null));
    return true;
  }

  // The open overlay of a page hands over its clip, or says it is gone
  // (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч12). Only the top frame of a page tab
  // has an overlay.
  if (msg.action === "openClipWrite") {
    const clip = msg.clip;
    if (!isPageTopFrame(sender) || !isOpenClip(clip)) {
      sendResponse({ ok: false });
      return false;
    }
    writeOpenClip(sender.tab.id, clip).then((kept) => sendResponse(kept === OPEN_CLIP_NOT_KEPT
      ? { ok: false, code: "open_clip_too_large", error: "This clip is too large to keep while the page changes." }
      : kept === OPEN_CLIP_KEPT_WITHOUT_SCREENSHOT ? { ok: true, screenshotKept: false } : { ok: true }),
    (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  if (msg.action === "openClipClear") {
    if (!isPageTopFrame(sender)) {
      sendResponse({ ok: false });
      return false;
    }
    clearOpenClip(sender.tab.id).then(() => {
      sendResponse({ ok: true });
      // The close that cleared it is when a pending update can apply (К4).
      scheduleReloadCheck();
    }, (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  // A new document of a tab whose overlay was open asks for its clip (Р7).
  if (msg.action === "restoreOpenClip") {
    if (!isPageTopFrame(sender)) {
      sendResponse({ ok: false, mode: "none" });
      return false;
    }
    restoreOpenClipInTab(sender.tab).then((mode) => sendResponse({ ok: mode === "overlay", mode }),
      (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  // Crop mode: a clipper asks background to start the crop overlay on its
  // page. An overlay asks from the page's own tab (it passes the sentinel -1
  // because it cannot know its tab id). The clipper window asks from its own
  // extension tab, which is not the page: it names its source tab, the same
  // rule captureForCrop follows (SPEC_AUDIT_FIXES.md, Б4.7).
  if (msg.action === "startCropMode") {
    const tabId = isExtensionPage(sender)
      ? (typeof msg.tabId === "number" && Number.isInteger(msg.tabId) && msg.tabId >= 0 ? msg.tabId : null)
      : sender.tab?.id ?? null;
    if (tabId == null) {
      sendResponse({ ok: false, error: "No target tab" });
      return true;
    }
    const cropId = typeof msg.cropId === "string" ? msg.cropId : null;
    startCropInTab(tabId, cropId).then(sendResponse,
      (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true; // async
  }

  // A clipper asks background to capture its page's viewport (content scripts
  // cannot call chrome.tabs.captureVisibleTab directly). An overlay captures
  // its own tab; the clipper window names its source tab. The frame is the
  // page the tab shows now, for any clip (SPEC_CLIPPER.md, Р9).
  if (msg.action === "captureForCrop") {
    const tabId = isExtensionPage(sender) && typeof msg.tabId === "number" ? msg.tabId : sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No page to capture" });
      return true;
    }
    captureTabViewport(tabId).then((dataUrl) => {
      const cached = cacheScreenshotUpload(dataUrl);
      sendResponse(cached.ok ? { ok: true, dataUrl, screenshotId: cached.screenshotId } : cached);
    }, (error) => sendResponse({ ok: false, error: failureText(error) }));
    return true;
  }

  // Content script reports crop completion (either done with dataUrl, or cancelled).
  // Background just persists the result. We don't try chrome.action.openPopup() —
  // it requires a user gesture on the extension icon itself, which isn't
  // available in an async callback from the content script. Content script
  // shows an on-page toast asking the user to click the extension icon; popup
  // will rehydrate from chrome.storage.session on next open.
  if (msg.action === "cropDone") {
    // A crop refused (the page changed under it) reaches the reopened window
    // as its reason, shown in the editor.
    /** @type {{ status: "done" | "cancelled", dataUrl?: unknown, screenshotId?: string, error?: string }} */
    let result = { status: "cancelled", ...(typeof msg.error === "string" ? { error: msg.error } : {}) };
    if (msg.status === "done") {
      const cached = cacheScreenshotUpload(msg.dataUrl);
      result = cached.ok
        ? { status: "done", dataUrl: msg.dataUrl, screenshotId: cached.screenshotId }
        : { status: "cancelled", error: cached.error };
    }
    chrome.storage.session.set({ cropResult: result }).then(() => {
      // Badge the extension icon so the user sees something changed
      if (msg.status === "done") {
        chrome.action.setBadgeText({ text: "1" });
        chrome.action.setBadgeBackgroundColor({ color: "#333333" });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});
