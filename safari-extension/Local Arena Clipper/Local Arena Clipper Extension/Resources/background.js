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

const HOST_NAME = "com.localarena.clipper";
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

async function openClipperUi(tab, options = {}) {
  const { tabId, tabUrl } = await resolveClipperTarget(tab, options.fallbackUrl ?? null);
  const allowWindowFallback = options.allowWindowFallback !== false;

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
  const win = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    ...bounds,
  });
  if (win?.id) rememberPopupWindow(win.id);
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

async function handleContextMenuClick(info, tab) {
  // Store context info — useClipperState will read it via getContextMenuData()
  // on mount and apply it to metadata (type=image from srcUrl, etc.)
  const context = {
    menuItemId: info.menuItemId,
    srcUrl: info.srcUrl || null,
    linkUrl: info.linkUrl || null,
    selectionText: info.selectionText || null,
    pageUrl: info.pageUrl || tab?.url || null,
    frameUrl: info.frameUrl || null,
  };
  await chrome.storage.session.set({ contextMenuData: context });

  await openClipperUi(tab, { fallbackUrl: bestContextMenuPageUrl(info, tab) });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch((e) => {
    console.error("[Mine] context menu click failed:", e);
  });
});

// ── Native messaging ──────────────────────────────────────────────────────

// Send a message to the native host and return the response.
// Uses connectNative for persistent connection within a session.
// Responses are matched by the messageId the host echoes back; older hosts
// that don't echo it fall back to FIFO order (resolve oldest pending).
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

// save_block может последовательно/параллельно качать до 30 inline-картинок.
// Worst case: ureq retry × 15s × per-domain ограничения ≈ 150s. 180s — буфер.
// Остальные actions (get_status, list_channels, …) — мгновенные read-only.
function timeoutForAction(action) {
  return action === "save_block" ? 180_000 : 30_000;
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
    }, timeoutForAction(message?.action));

    pendingCallbacks.set(id, { resolve, timeout });

    port.postMessage({ ...message, _messageId: id });
  });
}

async function broadcastChannelsChanged(tag) {
  const message = {
    action: "mineChannelsChanged",
    tag: tag ?? null,
  };

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
  if (jar.length === 0) return { ok: false, error: "no session cookies for x.com" };

  return sendNativeMessage({
    action: "resolve_twitter_media",
    url: tweetUrl ?? null,
    tweet_id: tweetId ?? null,
    cookies: jar,
  });
}

// ── Message handler (from popup) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return false;

  if (msg.action === "nativeMessage") {
    sendNativeMessage(msg.payload).then((response) => {
      if (response?.ok && msg.payload?.action === "create_channel") {
        void broadcastChannelsChanged(response.tag ?? msg.payload?.tag ?? null);
      } else if (response?.ok && msg.payload?.action === "save_block" && msg.payload?.tags) {
        void broadcastChannelsChanged(null);
      }
      sendResponse(response);
    });
    return true; // async response
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
  // Used by the Instagram feed clip button where content script already has
  // preloadedClipData in storage.session. This path is overlay-only: the
  // page-injected button must not silently open a detached popup window.
  if (msg.action === "showOverlayInThisTab") {
    const tab = sender.tab;
    if (!tab) {
      sendResponse({ ok: false, error: "No sender tab" });
      return true;
    }
    openClipperUi(tab, {
      fallbackUrl: typeof msg.pageUrl === "string" ? msg.pageUrl : null,
      allowWindowFallback: false,
    }).then(
      (mode) => sendResponse({ ok: mode === "overlay", mode }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
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

  // Content script asks background to capture the viewport (content scripts
  // cannot call chrome.tabs.captureVisibleTab directly).
  if (msg.action === "captureForCrop") {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    const capture = windowId !== undefined
      ? (cb) => chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 95 }, cb)
      : (cb) => chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 95 }, cb);
    prepareTabForViewportCapture(tabId, () => {
      capture((dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message ?? "Capture failed" });
          return;
        }
        const cached = cacheScreenshotUpload(dataUrl);
        if (!cached.ok) {
          sendResponse(cached);
          return;
        }
        sendResponse({ ok: true, dataUrl, screenshotId: cached.screenshotId });
      });
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
