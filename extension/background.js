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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Store context info for the popup to retrieve
  const context = {
    menuItemId: info.menuItemId,
    srcUrl: info.srcUrl || null,
    linkUrl: info.linkUrl || null,
    selectionText: info.selectionText || null,
    pageUrl: info.pageUrl || tab?.url || null,
  };

  chrome.storage.session.set({ contextMenuData: context }, () => {
    // Open popup programmatically (via action)
    if (tab?.id) {
      chrome.action.openPopup();
    }
  });
});

// ── Native messaging ──────────────────────────────────────────────────────

// Send a message to the native host and return the response.
// Uses connectNative for persistent connection within a session.
let nativePort = null;
let pendingCallbacks = [];
let messageId = 0;

function getNativePort() {
  if (nativePort) return nativePort;

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    return null;
  }

  nativePort.onMessage.addListener((msg) => {
    const cb = pendingCallbacks.shift();
    if (cb) cb(msg);
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected";
    // Reject all pending callbacks
    for (const cb of pendingCallbacks) {
      cb({ ok: false, error });
    }
    pendingCallbacks = [];
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

    pendingCallbacks.push(resolve);

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      const idx = pendingCallbacks.indexOf(resolve);
      if (idx >= 0) {
        pendingCallbacks.splice(idx, 1);
        resolve({ ok: false, error: "Native host timeout" });
      }
    }, 30000);

    // Wrap resolve to clear timeout
    const originalResolve = resolve;
    const wrappedIdx = pendingCallbacks.length - 1;
    pendingCallbacks[wrappedIdx] = (msg) => {
      clearTimeout(timeout);
      originalResolve(msg);
    };

    port.postMessage(message);
  });
}

// ── Message handler (from popup) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return false;

  if (msg.action === "nativeMessage") {
    sendNativeMessage(msg.payload).then(sendResponse);
    return true; // async response
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
