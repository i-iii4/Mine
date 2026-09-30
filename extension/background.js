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
// globalThis — the same convention every lib/ file follows.
importScripts("generated/save-core/mine_core.js", "lib/mineCore.js", "lib/saveProtocol.js", "lib/standaloneVault.js");
importScripts("lib/storedValue.js", "lib/draftStore.js");

const HOST_NAME = "com.mine.clipper.v1";
const DRAFT_SESSION_KEY = "mineDraftBrowserSession";
let draftSessionPromise = null;
function currentDraftSession() {
  if (!draftSessionPromise) draftSessionPromise = (async () => {
    const stored = await chrome.storage.session.get(DRAFT_SESSION_KEY);
    if (typeof stored[DRAFT_SESSION_KEY] === "string") return stored[DRAFT_SESSION_KEY];
    const session = crypto.randomUUID();
    await chrome.storage.session.set({ [DRAFT_SESSION_KEY]: session });
    return session;
  })().catch(error => { draftSessionPromise = null; throw error; });
  return draftSessionPromise;
}
async function attachClipperDraft(store, message, sourceTabId) {
  const [captureSession, tabs] = await Promise.all([currentDraftSession(), chrome.tabs.query({})]);
  return store.attach(message.sourceUrl, {
    ...message.options, captureSession,
    captureScope: sourceTabId === null ? "extension" : String(sourceTabId),
    activeScopes: ["extension", ...tabs.filter(tab => Number.isInteger(tab.id)).map(tab => String(tab.id))],
  });
}
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

function isContentScriptCompatible(url) {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://");
}

function bestContextMenuPageUrl(info, tab) {
  return tab?.url || info?.pageUrl || info?.frameUrl || info?.srcUrl || info?.linkUrl || null;
}

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

/// Capture the viewport of `tabId` only while it is the tab in front of its
/// window: `captureVisibleTab` takes whatever tab is in front, and a clip must
/// never receive another page (SPEC_AUDIT_FIXES.md, Ф6).
async function captureTabViewport(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    throw new Error("The page is not in front of its window. Bring it forward and retake the screenshot.");
  }
  await new Promise((resolve) => prepareTabForViewportCapture(tabId, resolve));
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 95 }, (url) => {
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
  return dataUrl;
}

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

function showExistingClipperOverlay(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "showClipperOverlay" }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(resp?.ok));
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

async function sessionRecord(key) {
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? {};
}

async function recordClipperLaunch(tab, source) {
  if (typeof tab?.id !== "number") return;
  const launches = await sessionRecord(CLIPPER_LAUNCHES_KEY);
  launches[tab.id] = {
    sourceTabId: tab.id,
    sourceUrl: tab.url || source.fallbackUrl || null,
    sourceTitle: tab.title || null,
    contextMenu: source.contextMenu ?? null,
    preloaded: source.preloaded ?? null,
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [CLIPPER_LAUNCHES_KEY]: launches });
}

async function forgetClipperLaunch(tabId) {
  const launches = await sessionRecord(CLIPPER_LAUNCHES_KEY);
  if (!(tabId in launches)) return;
  delete launches[tabId];
  await chrome.storage.session.set({ [CLIPPER_LAUNCHES_KEY]: launches });
}

async function rememberClipperWindowSource(windowId, tabId) {
  const sources = await sessionRecord(CLIPPER_WINDOW_SOURCES_KEY);
  sources[windowId] = tabId;
  await chrome.storage.session.set({ [CLIPPER_WINDOW_SOURCES_KEY]: sources });
}

async function forgetClipperWindowSource(windowId) {
  const sources = await sessionRecord(CLIPPER_WINDOW_SOURCES_KEY);
  if (!(windowId in sources)) return;
  delete sources[windowId];
  await chrome.storage.session.set({ [CLIPPER_WINDOW_SOURCES_KEY]: sources });
}

function isExtensionPage(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

/// The source tab of the clipper that asks: an overlay asks from the page's
/// own tab; the window asks from an extension page and is mapped to the tab
/// it opened for. The window may ask before its source is written, so it
/// waits a moment for it.
async function clipperSourceTab(sender) {
  if (!isExtensionPage(sender)) return sender.tab?.id ?? null;
  const windowId = sender.tab?.windowId;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sourceTabId = (await sessionRecord(CLIPPER_WINDOW_SOURCES_KEY))[windowId];
    if (typeof sourceTabId === "number") return sourceTabId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/// The launch of the asking clipper. Buffered page data is handed out once;
/// the source stays for a remount of the same clipper.
async function takeClipperLaunch(sender) {
  const sourceTabId = await clipperSourceTab(sender);
  if (typeof sourceTabId !== "number") return null;
  const launches = await sessionRecord(CLIPPER_LAUNCHES_KEY);
  const launch = launches[sourceTabId];
  if (!launch) return null;
  launches[sourceTabId] = { ...launch, contextMenu: null, preloaded: null };
  await chrome.storage.session.set({ [CLIPPER_LAUNCHES_KEY]: launches });
  if (Date.now() - launch.createdAt > CLIPPER_LAUNCH_TTL_MS) {
    return { ...launch, contextMenu: null, preloaded: null };
  }
  return launch;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetClipperLaunch(tabId).catch(() => undefined);
});

async function openClipperUi(tab, options = {}) {
  const { tabId, tabUrl } = await resolveClipperTarget(tab, options.fallbackUrl ?? null);
  const allowWindowFallback = options.allowWindowFallback !== false;
  // Every opening writes its own launch: a buffer left by an opening that
  // failed never reaches this one.
  await recordClipperLaunch(tab, {
    fallbackUrl: tabUrl,
    contextMenu: options.contextMenu ?? null,
    preloaded: options.preloaded ?? null,
  });

  if (tabId && isContentScriptCompatible(tabUrl)) {
    try {
      if (await showExistingClipperOverlay(tabId)) {
        return "overlay";
      }

      // Inject the overlay bundle into the tab's isolated world.
      // Only inject when no overlay listener is already present. Re-injecting
      // while an overlay is open creates an independent module scope, leaving
      // the old host visible and unowned during screenshot capture.
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/overlay.js"],
      });
      if (await showExistingClipperOverlay(tabId)) {
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
    console.warn("[Mine] clipper window position refused, opening at default:", String(error?.message ?? error));
    win = await chrome.windows.create({
      url: popupUrl,
      type: "popup",
      width: bounds.width,
      height: bounds.height,
    });
  }
  if (win?.id) {
    rememberPopupWindow(win.id);
    if (typeof tab?.id === "number") await rememberClipperWindowSource(win.id, tab.id);
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

async function resolvePopupBounds() {
  const stored = await chrome.storage.local.get("popupBounds");
  if (stored.popupBounds && typeof stored.popupBounds.left === "number") {
    // Always force width to match the body CSS — user may only customize
    // position and height. Height stays user-defined so they can resize.
    return {
      width: POPUP_DEFAULT_WIDTH,
      height: stored.popupBounds.height ?? POPUP_DEFAULT_HEIGHT,
      left: stored.popupBounds.left,
      top: stored.popupBounds.top,
    };
  }
  // Default: top-right of the currently focused browser window
  try {
    const current = await chrome.windows.getCurrent();
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

async function rememberPopupWindow(windowId) {
  const stored = await chrome.storage.session.get(POPUP_WINDOW_IDS_KEY);
  const ids = new Set(stored[POPUP_WINDOW_IDS_KEY] ?? []);
  ids.add(windowId);
  await chrome.storage.session.set({ [POPUP_WINDOW_IDS_KEY]: [...ids] });
}

async function isOurPopup(windowId) {
  const stored = await chrome.storage.session.get(POPUP_WINDOW_IDS_KEY);
  return (stored[POPUP_WINDOW_IDS_KEY] ?? []).includes(windowId);
}

async function forgetPopupWindow(windowId) {
  const stored = await chrome.storage.session.get(POPUP_WINDOW_IDS_KEY);
  const ids = (stored[POPUP_WINDOW_IDS_KEY] ?? []).filter((id) => id !== windowId);
  await chrome.storage.session.set({ [POPUP_WINDOW_IDS_KEY]: ids });
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

async function handleContextMenuClick(info, tab) {
  // The clicked target travels with this opening only (Ф6); useClipperState
  // reads it through getClipperLaunch and applies it to the metadata.
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
let nativePort = null;
const pendingCallbacks = new Map();
let messageId = 0;
const screenshotUploads = new Map();
let screenshotUploadId = 0;

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
  } catch (e) {
    return null;
  }

  const port = nativePort;
  port.onMessage.addListener((msg) => {
    if (msg?.code === "host_replaced") {
      retireReplacedHost(port, msg);
      return;
    }
    const id = msg._messageId;
    if (id !== undefined && pendingCallbacks.has(id)) {
      const { resolve, timeout, action } = pendingCallbacks.get(id);
      pendingCallbacks.delete(id);
      clearTimeout(timeout);
      resolve(msg);
      if (action === "get_status") {
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
// reload in a loop.
let ownRuntimeIdentity = null;

function runtimeIdentity() {
  ownRuntimeIdentity ??= fetch(chrome.runtime.getURL("dist/runtime-identity.json"))
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return ownRuntimeIdentity;
}

async function noteInstalledExtension(status) {
  const installed = status?.extension_build_id;
  if (typeof installed !== "string" || installed.length === 0) return;
  const own = await runtimeIdentity();
  if (typeof own?.buildId !== "string" || own.buildId === installed) return;
  const { mineReloadedFor } = await chrome.storage.local.get("mineReloadedFor");
  if (mineReloadedFor === installed) return;
  await chrome.storage.session.set({ mineReloadPending: installed });
}

async function reloadIfUpdated() {
  const { mineReloadPending } = await chrome.storage.session.get("mineReloadPending");
  if (typeof mineReloadPending !== "string") return;
  // A save in flight finishes first; its end checks again.
  if (browserWritesInFlight > 0) return;
  for (const [, pending] of pendingCallbacks) {
    if (pending.action === "save_block") return;
  }
  // Closing one clipper must not take away another one still open.
  if (await anyEditorOpen()) return;
  await chrome.storage.local.set({ mineReloadedFor: mineReloadPending });
  await chrome.storage.session.remove("mineReloadPending");
  chrome.runtime.reload();
}

// Writes into the folder chosen in the browser run inside this worker; a
// reload would cut them off.
let browserWritesInFlight = 0;

function trackBrowserWrite(work) {
  browserWritesInFlight += 1;
  return Promise.resolve()
    .then(work)
    .finally(() => {
      browserWritesInFlight -= 1;
      scheduleReloadCheck();
    });
}

// Check again once the answer has reached the page: a pending update waits
// for the save, not for the next time a clipper happens to close.
function scheduleReloadCheck() {
  setTimeout(() => {
    void reloadIfUpdated().catch((error) => console.warn("[Mine] extension reload failed:", String(error?.message ?? error)));
  }, 1000);
}

// Whether a clipper is open anywhere: an extension page (the window used where
// the overlay cannot run, the folder setup page) or the overlay in some tab.
// A browser that cannot list extension pages is treated as having one open.
async function anyEditorOpen() {
  if (typeof chrome.runtime.getContexts !== "function") return true;
  const pages = await chrome.runtime.getContexts({ contextTypes: ["TAB", "POPUP", "SIDE_PANEL"] });
  if (pages.length > 0) return true;
  const tabs = await chrome.tabs.query({});
  const answers = await Promise.all(tabs.map((tab) => (typeof tab.id !== "number"
    ? false
    : chrome.tabs.sendMessage(tab.id, { action: "mineClipperIsOpen" }, { frameId: 0 })
      .then((answer) => answer?.open === true, () => false))));
  return answers.some(Boolean);
}

// A newer helper was installed while this connection stayed open (К4). The
// old process answers `host_replaced` to the first request it reads and ends
// without acting on it; the requests still waiting were never read. Every one
// of them goes again, once, to the new helper.
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

// save_block может последовательно/параллельно качать до 30 inline-картинок.
// Worst case: ureq retry × 15s × per-domain ограничения ≈ 150s. 180s — буфер.
// Остальные actions короткие; только явный diagnostic ACK сохраняет отметку связи.
function timeoutForAction(action) {
  if (action === "save_block") return 180_000;
  // The folder chooser waits on a human, not on IPC.
  if (action === "pick_vault_folder") return 300_000;
  return 30_000;
}

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

function sendNativeMessage(message, expectedPort = null, afterReplacement = false) {
  return new Promise((settle) => {
    // The replaced helper did nothing with the request: it goes once to the
    // new helper. A check bound to the old connection has nothing to confirm.
    const resolve = (reply) => settle(reply?.code === "host_replaced" && !expectedPort && !afterReplacement
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

    const timeout = setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        resolve({ ok: false, error: "Mine helper did not respond in time", code: "native_timeout", outcome: "unknown" });
      }
    }, timeoutForAction(message?.action));

    pendingCallbacks.set(id, { resolve, timeout, action: message?.action });

    try {
      port.postMessage({ ...message, _messageId: id });
    } catch (error) {
      clearTimeout(timeout);
      pendingCallbacks.delete(id);
      resolve({ ok: false, error: String(error?.message ?? error), code: "native_disconnected", outcome: "unknown" });
    }
  });
}

async function broadcastChannelsChanged(tag) {
  return broadcastClipperMessage({ action: "mineChannelsChanged", tag: tag ?? null });
}

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

async function ensureDefuddleInjected(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { ok: false, error: "No sender tab" };
  }

  const target = { tabId };
  if (Number.isInteger(sender.frameId)) {
    target.frameIds = [sender.frameId];
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

async function uploadFileToNativeHost({ port, token, filename, screenshotId, vaultPath }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
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
    const result = await resp.json();
    if (result?.ok) screenshotUploads.delete(screenshotId);
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
async function resolveAuthenticatedTweetVideo({ tweetUrl, tweetId }) {
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

// ── Message handler (from popup) ──────────────────────────────────────────

function extensionBackgroundFailure(error) {
  return {
    ok: false,
    error: String(error?.message ?? error),
    code: "extension_background_error",
    outcome: "unknown",
  };
}

// Chromium APIs return Promises, while Dia versions of the same APIs may only
// invoke callbacks. Supplying both completion paths is safe as long as the
// response channel is settled exactly once.
function respondToBrowserCreate(sendResponse, invoke) {
  let answered = false;
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
const folderSetupRequests = new Map();
function browserCall(invoke) {
  return new Promise((resolve, reject) => {
    try {
      const pending = invoke((value) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(value);
      });
      if (pending?.then) pending.then(resolve, reject);
    } catch (error) { reject(error); }
  });
}
function openFolderSetup(url) {
  if (folderSetupRequests.has(url)) return folderSetupRequests.get(url);
  const operation = (async () => {
    const windows = await browserCall(callback => chrome.windows.getAll({ populate: true }, callback));
    const existing = windows.find(window => window.tabs?.some(tab => tab.url === url));
    if (existing) {
      await browserCall(callback => chrome.windows.update(existing.id, { focused: true }, callback));
    } else {
      await browserCall(callback => chrome.windows.create({ url, type: "popup", width: 420, height: 280, focused: true }, callback));
    }
    return { ok: true };
  })();
  folderSetupRequests.set(url, operation);
  operation.finally(() => folderSetupRequests.delete(url)).catch(() => {});
  return operation;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return false;

  if (msg.action === "collectXThread") {
    const source = sender.url || sender.tab?.url || "";
    const match = source.match(/^https:\/\/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)(?:[/?#]|$)/);
    if (!match || match[1] !== msg.tweetId || sender.tab?.id === undefined || sender.frameId !== 0) {
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

  if (msg.action === "openStandaloneSetup") {
    const url = new URL(chrome.runtime.getURL("dist/index.html?mode=setup"));
    if (typeof msg.binding_id === "string") url.searchParams.set("binding_id", msg.binding_id);
    openFolderSetup(url.href).then(sendResponse, error => sendResponse(extensionBackgroundFailure(error)));
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
    }).catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  // The clipper overlay closed: the moment an update can apply (К4).
  if (msg.action === "mineClipperClosed") {
    void reloadIfUpdated().catch((error) => console.warn("[Mine] extension reload failed:", String(error?.message ?? error)));
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
    Promise.resolve().then(async () => {
      let identity = { buildId: "unbuilt", commit: "unknown" };
      try {
        const response = await fetch(chrome.runtime.getURL("dist/runtime-identity.json"));
        if (!response.ok) throw new Error("runtime identity is unavailable");
        const value = await response.json();
        if (typeof value.buildId === "string" && typeof value.commit === "string") identity = value;
      } catch (error) {
        console.warn("[Mine] runtime identity unavailable:", String(error.message ?? error));
      }
      sendResponse({ ok: supported, save_protocols: [1], features: ["save_operation_v1", "operation_lookup_v1"],
        build_id: identity.buildId, commit: identity.commit,
        ...(supported ? {} : { code: "incompatible_protocol", error: "This Mine widget uses an unsupported protocol. Its saved draft has been preserved. Reload the page to open the current widget." }) });
    }).catch(error => sendResponse(extensionBackgroundFailure(error)));
    return true;
  }

  if (["draftRead", "draftWrite", "draftClear", "draftAttach", "draftWriteOwned", "draftClearOwned"].includes(msg.action)) {
    const store = globalThis.MineDraftStore;
    const extensionPage = sender.url?.split("?")[0] === chrome.runtime.getURL("dist/index.html");
    const sourceTabId = extensionPage && Number.isInteger(msg.sourceTabId) && msg.sourceTabId >= 0
      ? msg.sourceTabId : sender.tab?.id ?? null;
    const operation = msg.action === "draftAttach" ? attachClipperDraft(store, msg, sourceTabId)
      : msg.action === "draftWriteOwned" ? store.writeOwned(msg.sourceUrl, msg.draft, msg.expectedRevision, msg.ownership)
      : msg.action === "draftClearOwned" ? store.clearOwned(msg.sourceUrl, msg.draftId, msg.expectedRevision, msg.ownership)
      : msg.action === "draftRead" ? store.read(msg.sourceUrl)
      : msg.action === "draftWrite" ? store.write(msg.sourceUrl, msg.draft, msg.expectedRevision)
      : store.clear(msg.sourceUrl, msg.draftId, msg.expectedRevision);
    operation.then(draft => sendResponse({ ok: true, draft: draft ?? null }),
      error => sendResponse({ ok: false, code: error.code ?? "draft_storage_failed", error: String(error.message ?? error) }));
    return true;
  }

  if (msg.action === "nativeMessage") {
    try {
      sendNativeMessage(msg.payload).then((response) => {
        if (response?.ok && msg.payload?.action === "create_channel") {
          void broadcastChannelsChanged(response.tag ?? msg.payload?.tag ?? null);
        } else if (response?.ok && msg.payload?.action === "save_block" && msg.payload?.tags) {
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
      (error) => sendResponse({ configured: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (msg.action === "standaloneLookup") {
    globalThis.MineStandaloneVault.lookupOperation(msg.operation_id, msg.binding_id).then(sendResponse,
      (error) => sendResponse({ ok: false, outcome: "unknown", error: String(error?.message ?? error) }));
    return true;
  }

  if (msg.action === "standaloneSave") {
    trackBrowserWrite(() => globalThis.MineStandaloneVault.saveStandaloneBlock(msg.payload ?? {})).then((response) => {
      if (response?.ok && msg.payload?.tags) {
        void broadcastChannelsChanged(null);
      }
      sendResponse(response);
    }, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (msg.action === "standaloneListChannels") {
    globalThis.MineStandaloneVault.listStandaloneChannels().then(
      sendResponse,
      (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
    );
    return true;
  }

  if (msg.action === "standaloneCreateChannel") {
    trackBrowserWrite(() => globalThis.MineStandaloneVault.createStandaloneChannel(msg.tag, msg.binding_id ?? null)).then((response) => {
      if (response?.ok) void broadcastChannelsChanged(response.tag ?? null);
      sendResponse(response);
    }, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (msg.action === "resolveAuthenticatedTweetVideo") {
    resolveAuthenticatedTweetVideo(msg.payload ?? {}).then(sendResponse);
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
    if (!tab) {
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

  // Crop mode: popup asks background to trigger the crop overlay on
  // the page. Target tab is taken from the sender, not from msg.tabId —
  // in content-script (overlay) context the caller passes a sentinel
  // value (-1) because it doesn't know its own tabId, and background
  // is the only place that can resolve it via sender.tab.id.
  if (msg.action === "startCropMode") {
    const tabId = sender.tab?.id ?? (typeof msg.tabId === "number" && msg.tabId >= 0 ? msg.tabId : null);
    if (tabId == null) {
      sendResponse({ ok: false, error: "No target tab" });
      return true;
    }
    chrome.tabs.sendMessage(tabId, { action: "startCropOverlay" }, (resp) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error:
            "Could not reach the page. Reload the tab after updating the extension.",
        });
        return;
      }
      sendResponse(resp || { ok: true });
    });
    return true; // async
  }

  // A clipper asks background to capture its page's viewport (content scripts
  // cannot call chrome.tabs.captureVisibleTab directly). An overlay captures
  // its own tab; the clipper window names its source tab.
  if (msg.action === "captureForCrop") {
    const tabId = isExtensionPage(sender) && typeof msg.tabId === "number" ? msg.tabId : sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No page to capture" });
      return true;
    }
    captureTabViewport(tabId).then((dataUrl) => {
      const cached = cacheScreenshotUpload(dataUrl);
      sendResponse(cached.ok ? { ok: true, dataUrl, screenshotId: cached.screenshotId } : cached);
    }, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  // Content script reports crop completion (either done with dataUrl, or cancelled).
  // Background just persists the result. We don't try chrome.action.openPopup() —
  // it requires a user gesture on the extension icon itself, which isn't
  // available in an async callback from the content script. Content script
  // shows an on-page toast asking the user to click the extension icon; popup
  // will rehydrate from chrome.storage.session on next open.
  if (msg.action === "cropDone") {
    let result = { status: "cancelled" };
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
