// Background service worker: context menus, native messaging bridge.
// Connects popup/content scripts to the native host via stdio.

const HOST_NAME = "com.localarena.clipper";
const POPUP_DEFAULT_WIDTH = 388;
const POPUP_DEFAULT_HEIGHT = 700;

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
    return {
      width: stored.popupBounds.width ?? POPUP_DEFAULT_WIDTH,
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

chrome.windows.onRemoved.addListener((windowId) => {
  forgetPopupWindow(windowId);
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Store context info for the popup to retrieve
  const context = {
    menuItemId: info.menuItemId,
    srcUrl: info.srcUrl || null,
    linkUrl: info.linkUrl || null,
    selectionText: info.selectionText || null,
    pageUrl: info.pageUrl || tab?.url || null,
  };

  // Store data, then open popup as a standalone window.
  // chrome.action.openPopup() doesn't work from context menu handlers
  // (requires user gesture on the extension icon), so we use windows.create().
  await chrome.storage.session.set({ contextMenuData: context });

  const popupUrl = chrome.runtime.getURL("dist/index.html");
  const bounds = await resolvePopupBounds();
  const win = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    ...bounds,
  });
  if (win?.id) rememberPopupWindow(win.id);
});

// ── Native messaging ──────────────────────────────────────────────────────

// Send a message to the native host and return the response.
// Uses connectNative for persistent connection within a session.
// Requests/responses are matched by messageId (not FIFO order).
let nativePort = null;
const pendingCallbacks = new Map();
let messageId = 0;

function getNativePort() {
  if (nativePort) return nativePort;

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    return null;
  }

  nativePort.onMessage.addListener((msg) => {
    // Native host echoes messageId back; fall back to oldest pending if missing
    const id = msg._messageId;
    if (id !== undefined && pendingCallbacks.has(id)) {
      const { resolve, timeout } = pendingCallbacks.get(id);
      pendingCallbacks.delete(id);
      clearTimeout(timeout);
      resolve(msg);
    } else {
      // Fallback for hosts that don't echo messageId: resolve oldest
      const first = pendingCallbacks.keys().next();
      if (!first.done) {
        const { resolve, timeout } = pendingCallbacks.get(first.value);
        pendingCallbacks.delete(first.value);
        clearTimeout(timeout);
        resolve(msg);
      }
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected";
    for (const [, { resolve, timeout }] of pendingCallbacks) {
      clearTimeout(timeout);
      resolve({ ok: false, error });
    }
    pendingCallbacks.clear();
    nativePort = null;
  });

  return nativePort;
}

function sendNativeMessage(message) {
  return new Promise((resolve) => {
    const port = getNativePort();
    if (!port) {
      resolve({
        ok: false,
        error: "Native host not installed. Reinstall Mine.",
      });
      return;
    }

    const id = ++messageId;

    const timeout = setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        resolve({ ok: false, error: "Native host timeout" });
      }
    }, 30000);

    pendingCallbacks.set(id, { resolve, timeout });

    port.postMessage({ ...message, _messageId: id });
  });
}

// ── Message handler (from popup) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return false;

  if (msg.action === "nativeMessage") {
    sendNativeMessage(msg.payload).then(sendResponse);
    return true; // async response
  }

  if (msg.action === "openClipperWithData") {
    chrome.storage.session.set({ preloadedClipData: msg.data }).then(async () => {
      const popupUrl = chrome.runtime.getURL("dist/index.html");
      const bounds = await resolvePopupBounds();
      const win = await chrome.windows.create({
        url: popupUrl,
        type: "popup",
        ...bounds,
      });
      if (win?.id) rememberPopupWindow(win.id);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "getContextMenuData") {
    chrome.storage.session.get("contextMenuData", (data) => {
      sendResponse(data.contextMenuData || null);
      // Clear after reading
      chrome.storage.session.remove("contextMenuData");
    });
    return true;
  }

  // Crop mode: popup asks background to trigger overlay in the target tab.
  // Must wait for the content script to acknowledge before resolving, so the
  // popup only closes after the overlay is actually visible on the page.
  if (msg.action === "startCropMode") {
    const tabId = msg.tabId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "Missing tabId" });
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

  // Content script asks background to capture the viewport (content scripts
  // cannot call chrome.tabs.captureVisibleTab directly).
  if (msg.action === "captureForCrop") {
    const windowId = sender.tab?.windowId;
    const capture = windowId !== undefined
      ? (cb) => chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 95 }, cb)
      : (cb) => chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 95 }, cb);
    capture((dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message ?? "Capture failed" });
        return;
      }
      sendResponse({ ok: true, dataUrl });
    });
    return true;
  }

  // Content script reports crop completion (either done with dataUrl, or cancelled).
  // Background just persists the result. We don't try chrome.action.openPopup() —
  // it requires a user gesture on the extension icon itself, which isn't
  // available in an async callback from the content script. Content script
  // shows an on-page toast asking the user to click the extension icon; popup
  // will rehydrate from chrome.storage.session on next open.
  if (msg.action === "cropDone") {
    const result = msg.status === "done"
      ? { status: "done", dataUrl: msg.dataUrl }
      : { status: "cancelled" };
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
