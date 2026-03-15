// Background service worker: context menus, native messaging bridge.
// Connects popup/content scripts to the native host via stdio.

const HOST_NAME = "com.localarena.clipper";

// ── Context menus ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-page",
    title: "Save page to Local Arena",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "save-image",
    title: "Save image to Local Arena",
    contexts: ["image"],
  });

  chrome.contextMenus.create({
    id: "save-selection",
    title: "Save selection to Local Arena",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "save-link",
    title: "Save link to Local Arena",
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

  const popupUrl = chrome.runtime.getURL("popup/popup.html");
  chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: 388,
    height: 520,
  });
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
        error: "Native host not installed. Reinstall Local Arena.",
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
      const current = await chrome.windows.getCurrent();
      const left = current.left + current.width - 388 - 20;
      const top = current.top + 80;
      chrome.windows.create({
        url: popupUrl,
        type: "popup",
        width: 388,
        height: 700,
        left: Math.round(left),
        top: Math.round(top),
      });
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

  return false;
});
