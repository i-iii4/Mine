import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { normalizeArticleMedia } from "../lib/normalizeArticleMedia";
import { hydrateTwitterPosts } from "../lib/twitterMedia";

import {
  sendToNative,
  type NativeResponse,
  listKnownVaults,
  uploadFile,
  cacheScreenshotUpload,
  getClipperLaunch,
  extractMetadata,
  extractArticleAsync,
  getImageInfo,
  detectTwitterLightbox,
  CONTENT_SCRIPT_CONTEXT,
  type NativeRequest,
  type ChannelInfo,
  type PageMetadata,
  type ArticleData,
  type ContextMenuData,
  pickVaultFolder,
  revealVault,
} from "../lib/messaging";

// Detection: when PopupApp runs as a content-script overlay, chrome.tabs /
// chrome.action are not exposed to that execution context. The window-entry
// fallback (detached popup window) still has them.
const IS_CONTENT_SCRIPT_CONTEXT = typeof chrome.tabs === "undefined";
// How often the collection list is asked again while the helper indexes.
const CHANNELS_RECHECK_MS = 3_000;
/** While Mine is out of reach the clipper asks again this often: Mine repairs
 *  the helper by itself, so nothing needs a button (SPEC_CLIPPER.md, errors). */
export const CLIPPER_RECONNECT_INTERVAL_MS = 3_000;
export const MINE_NOT_CONNECTED = "Mine isn't connected to this browser. Open Mine and the clipper connects on its own.";
export const MINE_NOT_ANSWERING = "Mine isn't answering. The clipper keeps trying.";
export const MINE_TOO_OLD = "This clipper needs a newer Mine. Open the updated Mine and the clipper connects on its own.";
/** Save stopped: the clip moved to another folder after Save was pressed, and
 *  the collections of the folder it was in no longer go with it (Г3.2). */
export const DESTINATION_CHANGED_DURING_SAVE = "The folder changed before this clip was saved. Nothing was saved: check the folder and collections, then save again.";

import { resolveCaptureResult } from "../lib/captureResult";
import {
  articleExtractionStateForResult,
  articleHasPreviewMedia,
  articleHasSaveableContent,
  articleHasText,
  buildLinkBody,
  contentModeNeedsArticleExtraction,
  emptyContentMessage,
  type ArticleExtractionState,
} from "../lib/articleExtractionState";
import { applySaveImageContextMenu, linkTargetMetadata } from "../lib/contextMenuMetadata";
import { pickImageCardUrl } from "../lib/postSourceUrl";
import {
  parseTwitterPhotoUrl,
  fetchTweetPhotoByIndex,
  type ResolvedLightboxImage,
} from "../lib/twitterPhotoLightbox";
import {
  canPickFolderHere,
  chooseStandaloneFolder,
  getStandaloneStatus,
  regrantStandaloneAccess,
  standaloneCreateChannel,
  standaloneListChannels,
  openStandaloneSetup,
  type StandaloneStatus,
  type StandaloneMode,
} from "../lib/standalone";
import { clearPendingSave, executePinnedSave, findPendingSave, persistPendingSave, persistSaveReceipt, type PinnedSaveOperation } from "../lib/saveOperation";
import { attachDraft, clearOwnedDraft, writeOwnedDraft, DraftStorageError, type ClipperDraftState, type DurableClipperDraft, type DraftOwnership } from "../lib/draft";
import { baselineSaveRequest, negotiateSaveProtocol, negotiateWidgetProtocol } from "../lib/protocol";
import { localSavedAt } from "../lib/savedAt";

export type ClipType = "content" | "link" | "image" | "video" | "screenshot";
export type PopupState = "loading" | "error" | "main";

/** What background answers to a screenshot request. */
interface CaptureReply {
  ok?: boolean;
  dataUrl?: string;
  screenshotId?: string;
  error?: string;
}

export interface ClipperState {
  state: PopupState;
  error: string | null;
  metadata: PageMetadata | null;
  articleData: ArticleData | null;
  channels: ChannelInfo[];
  channelsLoading: boolean;
  channelsError: string | null;
  /** A passing state of the collection list, such as indexing. */
  channelsNotice: string | null;
  /** Why the last collection could not be created; the editor stays. */
  collectionError: string | null;
  selectedTags: string[];
  currentType: ClipType;
  title: string;
  saving: boolean;
  draftReady: boolean;
  articleExtractionState: ArticleExtractionState;
  nativeStatusError: string | null;
  knownVaults: string[];
  selectedVault: string | null;
  saveMode: StandaloneMode;
  standaloneFolder: string | null;
}

export function useClipperState() {
  const [state, setState] = useState<PopupState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<PageMetadata | null>(null);
  const [articleData, setArticleData] = useState<ArticleData | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [channelsNotice, setChannelsNotice] = useState<string | null>(null);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const channelsRecheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelsRequestRef = useRef(0);
  const [selectedTags, setSelectedTagsValue] = useState<string[]>([]);
  // The collections chosen now, so that Save reads them in one snapshot with
  // the destination after its awaits, not from the render it began in
  // (SPEC_AUDIT_FIXES.md, Г3.2).
  const selectedTagsRef = useRef<string[]>([]);
  const setSelectedTags = useCallback((next: string[] | ((previous: string[]) => string[])) => {
    const value = typeof next === "function" ? next(selectedTagsRef.current) : next;
    selectedTagsRef.current = value;
    setSelectedTagsValue(value);
  }, []);
  const [currentType, setCurrentType] = useState<ClipType>("link");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [articleExtractionState, setArticleExtractionState] =
    useState<ArticleExtractionState>("idle");
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [screenshotDataUrl, setScreenshotDataUrlValue] = useState<string | null>(null);
  const [screenshotUploadId, setScreenshotUploadIdValue] = useState<string | null>(null);
  const screenshotRef = useRef<{ dataUrl: string | null; uploadId: string | null; generation: number }>({ dataUrl: null, uploadId: null, generation: 0 });
  const setScreenshotDataUrl = useCallback((dataUrl: string | null) => {
    if (screenshotRef.current.dataUrl !== dataUrl) {
      screenshotRef.current = { dataUrl, uploadId: null, generation: screenshotRef.current.generation + 1 };
      setScreenshotUploadIdValue(null);
    }
    setScreenshotDataUrlValue(dataUrl);
  }, []);
  const setScreenshotUploadId = useCallback((uploadId: string | null) => {
    screenshotRef.current.uploadId = uploadId;
    setScreenshotUploadIdValue(uploadId);
  }, []);
  const [cropSupported, setCropSupported] = useState<boolean>(false);
  const [nativeStatusError, setNativeStatusError] = useState<string | null>(null);
  const [nativeConnected, setNativeConnected] = useState(false);
  const [canOpenApp, setCanOpenApp] = useState(false);
  const [pendingOperation, setPendingOperation] = useState(false);
  const [savePrepared, setSavePrepared] = useState(false);
  const [previousOperation, setPreviousOperation] = useState<PinnedSaveOperation | null>(null);
  const [allowDifferentDraft, setAllowDifferentDraft] = useState(false);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [draftReadySource, setDraftReadySource] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [connectionChecking, setConnectionChecking] = useState(false);
  // Mine is out of reach or too old: the clipper keeps asking by itself.
  const [reconnecting, setReconnecting] = useState(false);
  const draftRevisionRef = useRef(0);
  const draftOwnerRef = useRef(crypto.randomUUID());
  const draftCaptureRef = useRef(draftId);
  const draftGenerationRef = useRef(0);
  const draftSequenceRef = useRef(0);
  const draftSnapshotsSupportedRef = useRef(false);
  const newCaptureRef = useRef(false);
  const draftRestoredRef = useRef(false);
  const draftOwnedRef = useRef(false);
  const editorChangedRef = useRef(false);
  const draftPendingMutationRef = useRef<{ sourceUrl: string; draft: DurableClipperDraft; expectedRevision: number; ownership: DraftOwnership } | null>(null);
  const mountedRef = useRef(true);
  const draftWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const draftStorageErrorRef = useRef<string | null>(null);
  // Which road a save takes (О2): the app when its host answers, the granted
  // folder when it does not, and neither until one of them exists.
  const [saveMode, setSaveMode] = useState<StandaloneMode>("app");
  const [standaloneFolder, setStandaloneFolder] = useState<string | null>(null);
  const saveModeRef = useRef<StandaloneMode>("app");
  const uploadPortRef = useRef<number | null>(null);
  const uploadTokenRef = useRef<string | null>(null);
  const supportsPendingUploadsRef = useRef(false);
  // What the connected helper declared it accepts (SPEC_CLIPPER.md, К4).
  const nativeFeaturesRef = useRef<string[]>([]);
  const nativeStatusErrorRef = useRef<string | null>(null);
  const nativeStatusPromiseRef = useRef<Promise<boolean> | null>(null);
  const nativeStatusGenerationRef = useRef<number | null>(null);
  const bindingIdRef = useRef<string | null>(null);
  // The name of the folder bindingIdRef names: the browser folder's name or
  // the space's path. Tells the person where a draft was made when it is
  // saved elsewhere (SPEC_AUDIT_FIXES.md, В4.4).
  const destinationLabelRef = useRef<string | null>(null);
  const [destinationNotice, setDestinationNotice] = useState<string | null>(null);
  // The app's settings generation seen last (SPEC_CLIPPER.md, К5).
  const configGenerationRef = useRef<number | null>(null);
  const saveProtocolRef = useRef<number | null>(null);
  const operationRef = useRef<PinnedSaveOperation | null>(null);
  const preparedOperationRef = useRef<PinnedSaveOperation | null>(null);
  const savingRef = useRef(false);
  const destinationRef = useRef<"native" | "browser" | null>(null);
  const destinationGenerationRef = useRef(0);
  // Moves of the clip to another folder. Each move clears the collections; a
  // Save pressed before a move and finishing after it would carry the old
  // folder's collections into the new one, so it stops instead (Г3.2).
  const destinationMoveRef = useRef(0);
  // From the moment a Save has read its destination until it ends, a
  // destination check does not move the editor; a check that came meanwhile
  // runs again once the Save is over (Г3.2).
  const saveDestinationHeldRef = useRef(false);
  const recheckAfterSaveRef = useRef(false);

  const tabIdRef = useRef<number | null>(null);
  const vaultRef = useRef<string | null>(null);
  const metadataRef = useRef<PageMetadata | null>(null);
  const articleDataRef = useRef<ArticleData | null>(null);
  const articleExtractionStateRef = useRef<ArticleExtractionState>("idle");
  const articleExtractionPromiseRef = useRef<Promise<ArticleData | null> | null>(null);
  const deferredArticleRef = useRef<ArticleData | null>(null);
  const extractionEpochRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      extractionEpochRef.current += 1;
      channelsRequestRef.current += 1;
    };
  }, []);

  const setMetadataValue = useCallback((value: PageMetadata | null) => {
    if (value !== metadataRef.current) {
      extractionEpochRef.current += 1;
      articleExtractionPromiseRef.current = null;
    }
    metadataRef.current = value;
    setMetadata(value);
  }, []);

  const setArticleDataValue = useCallback((value: ArticleData | null) => {
    const normalized = value ? normalizeArticleMedia(value, value.sourceUrl ?? metadataRef.current?.url ?? "") : null;
    articleDataRef.current = normalized;
    setArticleData(normalized);
  }, []);

  const setArticleExtractionStateValue = useCallback((value: ArticleExtractionState) => {
    articleExtractionStateRef.current = value;
    setArticleExtractionState(value);
  }, []);

  const cacheCapturedScreenshot = useCallback((dataUrl: string) => {
    const generation = screenshotRef.current.generation;
    void cacheScreenshotUpload(dataUrl).then((id) => {
      if (mountedRef.current && screenshotRef.current.generation === generation && screenshotRef.current.dataUrl === dataUrl) setScreenshotUploadId(id);
    }).catch(cause => console.warn("Screenshot cache unavailable; captured bytes retained", cause));
  }, [setScreenshotUploadId]);

  // The page address this clipper opened for, until metadata names the
  // document it was read from. Every screenshot and crop names it, and
  // background refuses a tab that shows another page since
  // (SPEC_AUDIT_FIXES.md, Ф6, Б4.5).
  const captureDocumentRef = useRef<string | null>(null);
  const captureDocumentUrl = useCallback(
    () => metadataRef.current?.documentUrl ?? captureDocumentRef.current,
    [],
  );
  // Screenshot requests are numbered; only the answer to the latest one is
  // applied. A failure is shown in the editor, which keeps its state and the
  // previous frame (SPEC_AUDIT_FIXES.md, Б4.6).
  const captureRequestRef = useRef(0);
  const [capturing, setCapturingValue] = useState(false);
  // A screenshot clip saves only once the frame being taken has arrived: it
  // saves what the preview shows, never the previous frame beside a newer
  // preview (SPEC_AUDIT_FIXES.md, Ф5, В4.5). Retake and Crop wait for a save
  // in turn. Other types do not carry the frame and do not wait for it.
  const capturingRef = useRef(false);
  const setCapturing = useCallback((value: boolean) => {
    capturingRef.current = value;
    setCapturingValue(value);
  }, []);
  const [captureError, setCaptureError] = useState<string | null>(null);
  // The crop this editor started in the overlay and has not had back yet.
  // An editor that closes cancels it, so the editor opened next never
  // receives its frame (SPEC_AUDIT_FIXES.md, Г3.3).
  const cropRequestRef = useRef<string | null>(null);
  useEffect(() => () => {
    const cropId = cropRequestRef.current;
    cropRequestRef.current = null;
    if (cropId !== null) pageCrop()?.cancel?.(cropId);
  }, []);

  const captureScreenshot = useCallback(() => {
    // Hide the overlay before capture so the clipper UI doesn't appear
    // in the screenshot. In overlay context __mineOverlay is exposed by
    // overlay-entry.tsx on the isolated-world window; in window-entry
    // context it's undefined and we skip the hide step entirely.
    const overlay = (globalThis as unknown as {
      __mineOverlay?: { hide: () => void; show: () => void };
    }).__mineOverlay;
    const request = ++captureRequestRef.current;
    const documentUrl = captureDocumentUrl();
    const isLatest = () => mountedRef.current && request === captureRequestRef.current;
    setCapturing(true);
    setCaptureError(null);

    const settle = (resp: CaptureReply | undefined) => {
      // Read even for an answer no longer wanted, so the browser does not
      // report the error as unchecked.
      const transportError = chrome.runtime.lastError;
      // An older answer arriving later, a failure included, neither replaces
      // the newer frame nor shows the overlay while the newer capture still
      // needs it hidden.
      if (!isLatest()) return;
      // Commit before the overlay comes back, so the keyboard returns to an
      // enabled Retake (overlay-entry.tsx, Б4.9).
      flushSync(() => {
        setCapturing(false);
        if (transportError) {
          setCaptureError(`Screenshot failed: ${transportError.message ?? "the extension did not answer"}`);
        } else if (!resp?.ok || !resp.dataUrl) {
          setCaptureError(resp?.error ?? "Screenshot capture failed");
        } else {
          setScreenshotDataUrl(resp.dataUrl);
          if (resp.screenshotId) {
            setScreenshotUploadId(resp.screenshotId);
          } else {
            cacheCapturedScreenshot(resp.dataUrl);
          }
        }
      });
      // One animation frame so React + paint complete before we restore the
      // overlay: avoids a visible flash mid-capture.
      if (overlay) requestAnimationFrame(() => overlay.show());
    };

    if (IS_CONTENT_SCRIPT_CONTEXT) {
      overlay?.hide();
      // Wait two animation frames: one for the host display:none to
      // apply, one for the browser to paint without the overlay. Only
      // then does captureVisibleTab see a clean viewport.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Replaced before it was sent: one capture less against the
          // browser's limit of two per second.
          if (!isLatest()) return;
          chrome.runtime.sendMessage({ target: "background", action: "captureForCrop", documentUrl }, settle);
        });
      });
      return;
    }
    // The detached window captures the page it was opened for, and only
    // while that page is in front (SPEC_AUDIT_FIXES.md, Ф6).
    chrome.runtime.sendMessage(
      { target: "background", action: "captureForCrop", tabId: tabIdRef.current, documentUrl },
      settle,
    );
  }, [cacheCapturedScreenshot, captureDocumentUrl, setCapturing, setScreenshotDataUrl, setScreenshotUploadId]);

  const retakeScreenshot = useCallback(() => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    editorChangedRef.current = true;
    captureScreenshot();
  }, [captureScreenshot]);

  const ensureArticleLoaded = useCallback(async (): Promise<ArticleData | null> => {
    const existing = articleDataRef.current;
    const needsThread = /https:\/\/(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/.test(metadataRef.current?.url || "")
      && !existing?.content.trim() && existing?.threadPostCount === undefined;
    if (!needsThread && articleHasSaveableContent(metadataRef.current, existing)) {
      setArticleExtractionStateValue("ready");
      return existing;
    }

    if (articleExtractionPromiseRef.current) {
      return articleExtractionPromiseRef.current;
    }

    const tabId = tabIdRef.current;
    const meta = metadataRef.current;
    if (tabId === null || !meta) {
      setArticleExtractionStateValue("failed");
      return null;
    }

    setArticleExtractionStateValue("loading");
    const epoch = extractionEpochRef.current;
    const promise = extractArticleAsync(tabId)
      .then(async (asyncArticle) => {
        if (extractionEpochRef.current !== epoch) return null;
        if (meta.documentUrl && asyncArticle.documentUrl && meta.documentUrl !== asyncArticle.documentUrl) {
          throw new Error("Capture document changed");
        }
        if (meta.captureGeneration && asyncArticle.captureGeneration && meta.captureGeneration !== asyncArticle.captureGeneration) {
          throw new Error("Capture navigation changed");
        }
        const hydrated = await hydrateTwitterVideoPreviews(meta, asyncArticle);
        if (extractionEpochRef.current !== epoch) return null;
        if (articleHasText(hydrated) || articleHasPreviewMedia(hydrated) || hydrated.threadWarning) {
          setArticleDataValue(hydrated);
          if (hydrated.title) {
            setTitle((current) => current === meta.title ? hydrated.title : current);
          }
        }

        setArticleExtractionStateValue(articleExtractionStateForResult(hydrated, meta));
        return hydrated;
      })
      .catch(() => {
        if (extractionEpochRef.current !== epoch) return null;
        setArticleExtractionStateValue("failed");
        return null;
      })
      .finally(() => {
        if (extractionEpochRef.current === epoch) articleExtractionPromiseRef.current = null;
      });

    articleExtractionPromiseRef.current = promise;
    return promise;
  }, [setArticleDataValue, setArticleExtractionStateValue]);

  const handleTypeChange = useCallback((type: ClipType) => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    editorChangedRef.current = true;
    extractionEpochRef.current += 1;
    articleExtractionPromiseRef.current = null;
    setCurrentType(type);
    if (type === "screenshot" && !screenshotDataUrl) {
      captureScreenshot();
    }
    if (type === "content" && contentModeNeedsArticleExtraction(metadataRef.current)) {
      void ensureArticleLoaded();
    }
  }, [screenshotDataUrl, captureScreenshot, ensureArticleLoaded]);

  const refreshChannelsRef = useRef<(vaultPath?: string | null, silent?: boolean) => Promise<void>>(async () => undefined);
  const refreshChannels = useCallback(async (vaultPath = vaultRef.current, silent = false) => {
    if (saveModeRef.current === "app" && vaultPath !== vaultRef.current) return;
    const request = ++channelsRequestRef.current;
    const generation = destinationGenerationRef.current;
    const mode = saveModeRef.current;
    const isCurrent = () => request === channelsRequestRef.current
      && generation === destinationGenerationRef.current && mode === saveModeRef.current
      && (mode !== "app" || vaultPath === vaultRef.current);
    if (channelsRecheckRef.current) {
      clearTimeout(channelsRecheckRef.current);
      channelsRecheckRef.current = null;
    }
    // A recheck while indexing keeps the names on screen instead of a
    // loading state (SPEC_CLIPPER.md, К3).
    if (!silent) setChannelsLoading(true);
    setChannelsError(null);
    try {
      const result = mode === "standalone"
        ? await standaloneListChannels()
        : await sendToNative({ action: "list_channels", vault_path: vaultPath, binding_id: bindingIdRef.current });
      if (!isCurrent()) return;
      if (result.ok && Array.isArray(result.channels)) {
        setChannels(result.channels);
        if ("indexing" in result && result.indexing === true) {
          setChannelsNotice("Mine is indexing this space. Card counts will appear shortly.");
          channelsRecheckRef.current = setTimeout(() => {
            channelsRecheckRef.current = null;
            void refreshChannelsRef.current(vaultPath, true);
          }, CHANNELS_RECHECK_MS);
        } else {
          setChannelsNotice(null);
        }
      } else {
        setChannelsNotice(null);
        setChannelsError("code" in result && result.code === "native_timeout"
          ? "Mine is busy with this space. Retry in a moment."
          : "Could not load collections.");
      }
    } catch {
      if (isCurrent()) setChannelsError("Could not load collections.");
    } finally {
      if (isCurrent()) setChannelsLoading(false);
    }
  }, []);
  useEffect(() => {
    refreshChannelsRef.current = refreshChannels;
  }, [refreshChannels]);
  useEffect(() => () => {
    if (channelsRecheckRef.current) clearTimeout(channelsRecheckRef.current);
  }, []);

  /// The spaces the popup can switch to, re-read from the app's list.
  const refreshKnownVaults = useCallback(() => {
    void listKnownVaults().then((vaultsResult) => {
      if (vaultsResult.ok) {
        setKnownVaults(vaultsResult.vaults);
        void chrome.storage.local.set({ mineKnownVaults: vaultsResult.vaults }).catch(cause => console.warn("Could not cache Mine folders", cause));
      }
    });
  }, []);

  /// Save into the granted browser folder. `chosen` is a folder the person
  /// picked in this editor; `found` is the folder selected at the moment,
  /// which may differ from the one the draft was made for.
  const enterStandaloneMode = useCallback((status: StandaloneStatus, change: "found" | "chosen" = "found") => {
    const folderName = status.folderName ?? "Folder";
    const binding = status.bindingId ?? null;
    const previousBinding = bindingIdRef.current;
    const previousLabel = destinationLabelRef.current;
    saveModeRef.current = "standalone";
    setSaveMode("standalone");
    setStandaloneFolder(folderName);
    bindingIdRef.current = binding;
    destinationLabelRef.current = folderName;
    destinationRef.current = "browser";
    nativeStatusErrorRef.current = null;
    setNativeStatusError(null);
    setReconnecting(false);
    if (previousBinding !== null && previousBinding !== binding) {
      // Collections are pages of the folder they were chosen in and do not
      // follow the clip into another one; a folder the person did not pick
      // here is named, so the destination is never a silent move
      // (SPEC_AUDIT_FIXES.md, Ф6, В4.4).
      destinationMoveRef.current += 1;
      setSelectedTags([]);
      setDestinationNotice(change === "chosen" ? null : movedDraftNotice(previousLabel, folderName));
    } else if (change === "chosen") {
      setDestinationNotice(null);
    }
    void refreshChannels();
  }, [refreshChannels, setSelectedTags]);

  /// Whether the destination may not change now: a save operation is under
  /// way or unresolved, or a running Save has read its destination. A check
  /// held back by a running Save runs again when the Save ends (Г3.2).
  const destinationHeld = useCallback((): boolean => {
    const held = operationRef.current !== null || preparedOperationRef.current !== null || saveDestinationHeldRef.current;
    if (held && savingRef.current) recheckAfterSaveRef.current = true;
    return held;
  }, []);

  const ensureNativeStatus = useCallback(async (refresh = false): Promise<boolean> => {
    if (nativeStatusPromiseRef.current) {
      if (!refresh || nativeStatusGenerationRef.current === destinationGenerationRef.current) return nativeStatusPromiseRef.current;
      await nativeStatusPromiseRef.current;
    }
    const generation = destinationGenerationRef.current;
    setConnectionChecking(true);

    const promise = Promise.all([
      getStandaloneStatus(),
      chrome.storage.local.get(["mineSaveDestination", "mineKnownVaults"]),
    ]).then(async ([standalone, stored]) => {
        if (generation !== destinationGenerationRef.current) return false;
        const selected = stored.mineSaveDestination;
        if (Array.isArray(stored.mineKnownVaults)) setKnownVaults(stored.mineKnownVaults.filter((path: unknown): path is string => typeof path === "string"));
        if (!destinationRef.current && selected && typeof selected === "object"
          && "executor" in selected && selected.executor === "native"
          && "vaultPath" in selected && typeof selected.vaultPath === "string") {
          destinationRef.current = "native";
          vaultRef.current = selected.vaultPath;
          setSelectedVault(selected.vaultPath);
          bindingIdRef.current = "bindingId" in selected && typeof selected.bindingId === "string" ? selected.bindingId : null;
          destinationLabelRef.current = selected.vaultPath;
        }
        if (!destinationRef.current && selected && typeof selected === "object"
          && "executor" in selected && selected.executor === "browser") {
          destinationRef.current = "browser";
        }
        // A granted browser folder needs nothing from the helper, and a
        // previously selected browser folder is not replaced when Mine
        // appears: the clipper saves at once instead of waiting for a helper
        // that may hang (SPEC_AUDIT_FIXES.md, А3.11). The helper status only
        // updates the connection indicators, in the background.
        if (destinationRef.current !== "native" && standalone.configured && standalone.permission === "granted") {
          if (destinationHeld()) return true;
          enterStandaloneMode(standalone);
          void sendToNative({ action: "get_status", vault_path: null, binding_id: null }).then((status) => {
            if (generation !== destinationGenerationRef.current) return;
            setNativeConnected(status.ok && status.connected !== false);
            setCanOpenApp(status.ok && status.features?.includes("open_app_v1") === true);
          }, () => undefined);
          return true;
        }
        // The host finds the space by its identity; the path is where it
        // was last seen (SPEC_CLIPPER.md, К1).
        const status = await sendToNative({
          action: "get_status",
          vault_path: vaultRef.current,
          binding_id: destinationRef.current === "native" ? bindingIdRef.current : null,
        });
        if (generation !== destinationGenerationRef.current) return false;
        if (typeof status.config_generation === "number") configGenerationRef.current = status.config_generation;
        setNativeConnected(status.ok && status.connected !== false);
        setCanOpenApp(status.ok && status.features?.includes("open_app_v1") === true);
        if (destinationHeld()) return true;
        saveProtocolRef.current = negotiateSaveProtocol(status);
        const compatible = saveProtocolRef.current !== null;
        uploadPortRef.current = typeof status.upload_port === "number" ? status.upload_port : null;
        uploadTokenRef.current = typeof status.upload_token === "string" ? status.upload_token : null;
        supportsPendingUploadsRef.current = Array.isArray(status.features)
          && status.features.includes("pending_uploads_v1");
        nativeFeaturesRef.current = Array.isArray(status.features)
          ? status.features.filter((feature): feature is string => typeof feature === "string")
          : [];

        // A previously selected browser folder is not replaced when Mine appears.
        if (destinationRef.current !== "native" && (standalone.configured || destinationRef.current === "browser")) {
          setStandaloneFolder(standalone.folderName ?? null);
          if (standalone.configured && standalone.permission === "granted") {
            enterStandaloneMode(standalone);
            return true;
          }
          destinationRef.current = "browser";
          const message = standalone.error ?? (standalone.configured
            ? `Write access to “${standalone.folderName ?? "Folder"}” is ${standalone.permission ?? "unavailable"}. Allow access or choose a folder.`
            : "The previously selected browser folder is unavailable. Choose it again; the destination has not been changed to Mine.");
          nativeStatusErrorRef.current = message;
          setNativeStatusError(message);
          saveModeRef.current = "unconfigured";
          setSaveMode("unconfigured");
          return false;
        }
        if (!compatible || !status.vaultConfigured || !status.vault_path || !status.binding_id) {
          // Plain words, not the browser's native-messaging error: the person
          // does one thing, open Mine, and the clipper does the rest.
          const message = !status.ok
            ? status.code === "extension_transport" || status.code === "extension_background_error"
              ? status.error ?? "Mine extension background stopped before replying. Retry this action."
              : status.code === "native_timeout"
                ? MINE_NOT_ANSWERING
                : MINE_NOT_CONNECTED
            : !compatible
              ? MINE_TOO_OLD
              : status.error ?? "The Mine helper is connected. Choose a folder to save your clips.";
          nativeStatusErrorRef.current = message;
          setNativeStatusError(message);
          // Out of reach or too old repairs itself in Mine; a folder to choose
          // is the person's decision and waits for them.
          setReconnecting(!status.ok || !compatible);
          const uncertain = status.outcome === "unknown" || status.code === "native_timeout" || status.code === "extension_transport" || status.code === "extension_background_error";
          saveModeRef.current = destinationRef.current === "native" || uncertain ? "app" : "unconfigured";
          setSaveMode(saveModeRef.current);
          // Without a reachable space there is nothing to load: the picker
          // stops waiting, and the other spaces stay one click away (К3).
          channelsRequestRef.current += 1;
          setChannelsLoading(false);
          setChannelsError("Collections appear once Mine can reach the space.");
          if (status.ok) refreshKnownVaults();
          return false;
        }
        // Hosts before К2 do not judge the binding; the popup compares it.
        const bindingRejected = status.binding_accepted === false
          || (typeof status.binding_accepted !== "boolean" && bindingIdRef.current !== null && bindingIdRef.current !== status.binding_id);
        if (bindingRejected && destinationRef.current === "native") {
          const message = "The selected folder binding changed. Choose the folder again before saving.";
          nativeStatusErrorRef.current = message;
          setNativeStatusError(message);
          saveModeRef.current = "app";
          setSaveMode("app");
          channelsRequestRef.current += 1;
          setChannelsLoading(false);
          setChannelsError("Collections appear once Mine can reach the space.");
          return false;
        }
        destinationRef.current = "native";
        bindingIdRef.current = status.binding_id;
        destinationLabelRef.current = status.vault_path;
        vaultRef.current = status.vault_path;
        setSelectedVault(status.vault_path);
        saveModeRef.current = "app";
        setSaveMode("app");
        await chrome.storage.local.set({ mineSaveDestination: { executor: "native", vaultPath: status.vault_path, bindingId: status.binding_id } });
        nativeStatusErrorRef.current = null;
        setNativeStatusError(null);
        setReconnecting(false);

        // Taxonomy and vault list are useful, but they must not block the
        // first paint of the clipper. Open overlays refresh again when another
        // tab creates a channel.
        refreshKnownVaults();
        void refreshChannels();
        return true;
      })
      .catch((cause) => {
        if (generation !== destinationGenerationRef.current) return false;
        const message = cause instanceof Error ? cause.message : String(cause);
        nativeStatusErrorRef.current = message;
        setNativeStatusError(message);
        setReconnecting(true);
        saveModeRef.current = destinationRef.current === "browser" ? "unconfigured" : "app";
        setSaveMode(saveModeRef.current);
        channelsRequestRef.current += 1;
        setChannelsLoading(false);
        setChannelsError("Collections appear once Mine can reach the space.");
        return false;
      })
      .finally(() => {
        // Only the latest check ends the checking state: Save stays
        // unavailable while any check may still move the destination (Г3.2).
        if (nativeStatusPromiseRef.current !== promise) return;
        nativeStatusPromiseRef.current = null;
        setConnectionChecking(false);
      });

    nativeStatusPromiseRef.current = promise;
    nativeStatusGenerationRef.current = generation;
    return promise;
  }, [destinationHeld, enterStandaloneMode, refreshChannels, refreshKnownVaults]);

  // Mine out of reach: ask again until it answers, so opening Mine is all it
  // takes (SPEC_CLIPPER.md, error table).
  useEffect(() => {
    if (!reconnecting) return;
    const timer = window.setInterval(() => {
      void ensureNativeStatus(true);
    }, CLIPPER_RECONNECT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ensureNativeStatus, reconnecting]);

  // Changes made in the app while the clipper stays open (a space renamed,
  // forgotten or added) reach it when the person comes back to it: a new
  // settings generation re-reads the destination and the space list (К5).
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
      if (configGenerationRef.current === null || destinationRef.current !== "native") return;
      void sendToNative({ action: "get_status", vault_path: vaultRef.current, binding_id: bindingIdRef.current }).then((status) => {
        if (typeof status.config_generation !== "number" || status.config_generation === configGenerationRef.current) return;
        if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
        destinationGenerationRef.current += 1;
        void ensureNativeStatus(true);
      });
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [ensureNativeStatus]);

  useEffect(() => {
    const onMessage = (msg: { action?: string }) => {
      if (msg?.action === "mineChannelsChanged") {
        void refreshChannels();
      }
      if (msg?.action === "mineStandaloneFolderChanged" && !operationRef.current && !preparedOperationRef.current && !savingRef.current) {
        destinationGenerationRef.current += 1;
        destinationRef.current = "browser";
        void ensureNativeStatus(true);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refreshChannels, ensureNativeStatus]);

  const captureSourceUrl = resolveCaptureResult(currentType, metadata, articleData).sourceUrl;
  const draftSourceUrl = metadata?.documentUrl ?? metadata?.url ?? "";
  useEffect(() => {
    if (!draftSourceUrl || state !== "main") return;
    let current = true;
    setDraftReadySource(null);
    draftOwnedRef.current = false;
    const settleDetached = () => {
      draftRestoredRef.current = true;
      draftOwnedRef.current = false;
      setDraftReadySource(draftSourceUrl);
    };
    const restore = async () => {
      const options = { ownerId: draftOwnerRef.current, captureId: draftCaptureRef.current, newCapture: newCaptureRef.current };
      let attached;
      try {
        attached = await attachDraft(draftSourceUrl, options, tabIdRef.current);
      } catch (cause) {
        if (!current || !isRecoverableDraftError(cause)) throw cause;
        // Attachment is idempotent for the same capture and editor. One retry
        // resolves a dropped reply without allocating or overwriting a draft.
        attached = await attachDraft(draftSourceUrl, options, tabIdRef.current);
      }
      if (!current) return;
      if (savingRef.current || operationRef.current || preparedOperationRef.current) {
        settleDetached();
        return;
      }
      if (attached.draft && !draftRestoredRef.current && editorChangedRef.current) {
        // The visible editor already has user changes. Preserve the old record
        // and acquire a separate capture instead of restoring over those edits.
        const captureId = crypto.randomUUID();
        attached = await attachDraft(draftSourceUrl, { ownerId: draftOwnerRef.current, captureId, newCapture: true }, tabIdRef.current);
        if (!current) return;
        if (savingRef.current || operationRef.current || preparedOperationRef.current) {
          settleDetached();
          return;
        }
      }
      const draft = attached.draft;
      draftOwnedRef.current = true;
      draftGenerationRef.current = attached.generation;
      draftSequenceRef.current = attached.sequence ?? 0;
      draftSnapshotsSupportedRef.current = attached.sequence !== undefined;
      draftCaptureRef.current = attached.draftId;
      setDraftId(attached.draftId);
      draftRevisionRef.current = draft?.revision ?? 0;
      draftStorageErrorRef.current = null;
      setDraftError(null);
      if (draft && !draftRestoredRef.current && !editorChangedRef.current) {
        const fresh = metadataRef.current;
        const sameDocument = fresh && (fresh.documentUrl ?? fresh.url) === (draft.state.metadata.documentUrl ?? draft.state.metadata.url);
        // The saved content survives reload, while future extraction binds to
        // the current instance only when it still represents this document.
        setMetadataValue(sameDocument && fresh.captureGeneration
          ? { ...draft.state.metadata, captureGeneration: fresh.captureGeneration }
          : draft.state.metadata);
        setArticleDataValue(draft.state.articleData);
        setArticleExtractionStateValue(draft.state.articleData ? articleExtractionStateForResult(draft.state.articleData, draft.state.metadata) : "idle");
        setTitle(draft.state.title);
        setSelectedTags(draft.state.selectedTags);
        setCurrentType(draft.state.currentType);
        setSelectedVault(draft.state.selectedVault);
        vaultRef.current = draft.state.selectedVault;
        destinationGenerationRef.current += 1;
        destinationRef.current = draft.state.executor;
        bindingIdRef.current = draft.state.bindingId;
        destinationLabelRef.current = draft.state.folderLabel ?? draft.state.selectedVault;
        setScreenshotDataUrl(draft.state.screenshotDataUrl);
        // Worker cache IDs are ephemeral; restored bytes get a fresh upload ID.
        setScreenshotUploadId(null);
        if (draft.state.screenshotDataUrl) cacheCapturedScreenshot(draft.state.screenshotDataUrl);
        void ensureNativeStatus(true);
      }
      draftRestoredRef.current = true;
      setDraftReadySource(draftSourceUrl);
    };
    void restore().catch((cause) => {
      if (!current) return;
      if (savingRef.current || operationRef.current || preparedOperationRef.current) {
        settleDetached();
        return;
      }
      const message = cause instanceof DraftStorageError && cause.code === "draft_ambiguous"
        ? "Several earlier clips from this page are preserved. Save will store the clip shown here."
        : "Previous edits could not be restored and remain untouched. Save will store the clip shown here.";
      draftStorageErrorRef.current = message;
      console.warn("Clipper draft restoration unavailable; previous edits preserved", cause);
      draftRestoredRef.current = true;
      // A detached editor may save through the durable operation journal, but
      // cannot autosave into a record whose contents and ownership are unknown.
      draftOwnedRef.current = false;
      setDraftReadySource(draftSourceUrl);
      setDraftError(message);
    });
    return () => { current = false; };
  }, [draftSourceUrl, state, setMetadataValue, setArticleDataValue, setArticleExtractionStateValue, ensureNativeStatus,
    cacheCapturedScreenshot, setScreenshotDataUrl, setScreenshotUploadId, setSelectedTags]);

  const persistCurrentDraft = useCallback(async () => {
    if (!metadata || !draftSourceUrl || draftReadySource !== draftSourceUrl || !draftOwnedRef.current) {
      throw new Error(draftStorageErrorRef.current ?? "The saved draft has not finished restoring. Retry when it is ready.");
    }
    const draftState: ClipperDraftState = {
      metadata, articleData, title, selectedTags, currentType, selectedVault,
      // Keep the legacy schema slot for older widgets, never a cache identity.
      screenshotDataUrl, screenshotUploadId: null, executor: destinationRef.current, bindingId: bindingIdRef.current,
      folderLabel: destinationLabelRef.current,
    };
    const previous = draftWriteQueueRef.current;
    const snapshotsSupported = draftSnapshotsSupportedRef.current;
    const sequence = ++draftSequenceRef.current;
    const generation = draftGenerationRef.current;
    const dispatch = async () => {
      // New workers order snapshots themselves. Only the legacy revision
      // protocol waits for the preceding reply to allocate its next edition.
      if (!snapshotsSupported && draftPendingMutationRef.current) {
        const confirmed = await confirmDraftMutation(draftPendingMutationRef.current);
        draftRevisionRef.current = confirmed.revision;
      }
      const expectedRevision = draftRevisionRef.current;
      const mutation = { sourceUrl: draftSourceUrl, expectedRevision, draft: {
        schemaVersion: 1, revision: expectedRevision + 1, draftId, state: draftState,
      } satisfies DurableClipperDraft, ownership: { ownerId: draftOwnerRef.current, generation, mutationId: crypto.randomUUID(),
        ...(snapshotsSupported ? { sequence } : {}) } };
      draftPendingMutationRef.current = mutation;
      try {
        const confirmed = await confirmDraftMutation(mutation);
        if (generation !== draftGenerationRef.current) return;
        draftRevisionRef.current = Math.max(draftRevisionRef.current, confirmed.revision);
        if (draftPendingMutationRef.current === mutation) draftPendingMutationRef.current = null;
        if (sequence === draftSequenceRef.current) {
          draftStorageErrorRef.current = null;
          if (mountedRef.current) setDraftError(null);
        }
      } catch (cause) {
        if (snapshotsSupported && sequence < draftSequenceRef.current) return;
        throw cause;
      }
    };
    // Dispatch before awaiting: closing the editor cannot cancel a snapshot
    // already handed to the durable worker queue.
    const writing = snapshotsSupported ? dispatch() : previous.catch(() => undefined).then(dispatch);
    draftWriteQueueRef.current = Promise.all([previous, writing.catch(() => undefined)]).then(() => undefined);
    await writing;
  }, [metadata, articleData, title, selectedTags, currentType, selectedVault, screenshotDataUrl,
    draftSourceUrl, draftReadySource, draftId]);

  useEffect(() => {
    if (!draftSourceUrl || draftReadySource !== draftSourceUrl || !draftOwnedRef.current || savingRef.current) return;
    void persistCurrentDraft().catch((cause) => {
      const message = "Edits are kept in this open clipper. Save will store the clip shown here.";
      draftStorageErrorRef.current = message;
      console.warn("Clipper autosave unavailable; visible edits retained", cause);
      if (mountedRef.current) setDraftError(message);
    });
  }, [draftSourceUrl, draftReadySource, persistCurrentDraft]);

  const confirmSavedOperation = useCallback(async (operation: PinnedSaveOperation, result: NativeResponse) => {
    // The executor has confirmed the source commit. A failed recovery receipt
    // cannot turn that outcome into failure or allocate another operation.
    operation.terminalResult = result;
    try {
      await persistSaveReceipt(operation, result);
    } catch (cause) {
      console.warn("Committed clip receipt deferred; original save journal retained", cause);
      return { ok: true as const, warning: result.warning };
    }
    const ownership = { ownerId: draftOwnerRef.current, generation: draftGenerationRef.current };
    const owned = draftOwnedRef.current;
    // A receipt remains discoverable until owner-fenced cleanup completes.
    // Autosave latency must not delay the visible source success.
    void draftWriteQueueRef.current.then(async () => {
      if (!owned || draftPendingMutationRef.current) return;
      await clearOwnedDraft(draftSourceUrl, operation.draftId ?? draftId, draftRevisionRef.current, ownership);
      await clearPendingSave(operation);
    }).catch(cause => console.warn("Saved clip recovery cleanup deferred", cause));
    return { ok: true as const, warning: result.warning };
  }, [draftSourceUrl, draftId]);

  useEffect(() => {
    if (!captureSourceUrl) return;
    let current = true;
    void findPendingSave(captureSourceUrl).then((pending) => {
      if (!current || operationRef.current || preparedOperationRef.current || savingRef.current) return;
      setPreviousOperation(pending);
    }).catch((cause) => {
      if (current) setNativeStatusError(`Could not read pending save: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return () => { current = false; };
  }, [captureSourceUrl]);

  const recoverPreviousSave = useCallback(async () => {
    if (!previousOperation || savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await executePinnedSave(previousOperation);
      if (result.ok || result.outcome === "committed") {
        await clearPendingSave(previousOperation);
        setPreviousOperation(null);
      }
      if (result.outcome === "not_committed" && result.terminal_rejected === true) {
        await clearPendingSave(previousOperation);
        setPreviousOperation(null);
      }
      return result;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [previousOperation]);

  const restorePreviousFolder = useCallback(async () => {
    if (previousOperation?.executor !== "browser") return;
    return openStandaloneSetup(previousOperation.bindingId);
  }, [previousOperation]);

  const startCropMode = useCallback(async () => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    if (!cropSupported || tabIdRef.current === null) return;

    // Background starts the crop overlay only while the page still shows the
    // address this clipper opened for, and the crop's capture names it too
    // (SPEC_AUDIT_FIXES.md, Ф6). A refusal is shown in the editor.
    const documentUrl = captureDocumentUrl();
    const requestCrop = (cropId: string | null) => new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      chrome.runtime.sendMessage(
        { target: "background", action: "startCropMode", tabId: tabIdRef.current, documentUrl, cropId },
        (resp?: { ok?: boolean; error?: string }) => {
          const transportError = chrome.runtime.lastError;
          if (transportError) {
            resolve({ ok: false, error: transportError.message ?? "The extension did not answer" });
          } else if (resp?.ok === true) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: resp?.error ?? "Could not start the crop. Reload the tab and try again." });
          }
        },
      );
    });
    setCaptureError(null);

    if (IS_CONTENT_SCRIPT_CONTEXT) {
      // Overlay context: hide the clipper overlay, trigger the crop
      // overlay in the same content script. React state stays alive in
      // memory — no persist, no rehydrate, no toast. When crop completes,
      // content.js calls window.__mineOverlay.show() which reveals us
      // again, and dispatches a mine-crop-result event we listen to; a
      // page that changed its address refuses the crop's capture there. The
      // crop is named: every editor of the tab hears the result, and only
      // this one takes it (SPEC_AUDIT_FIXES.md, Г3.3).
      const overlay = (globalThis as unknown as { __mineOverlay?: { hide: () => void; show: () => void } }).__mineOverlay;
      const cropId = crypto.randomUUID();
      cropRequestRef.current = cropId;
      overlay?.hide();
      const crop = pageCrop();
      if (crop) {
        crop.start(documentUrl, cropId);
        return;
      }
      const response = await requestCrop(cropId);
      if (response.ok || !mountedRef.current) return;
      if (cropRequestRef.current === cropId) cropRequestRef.current = null;
      overlay?.show();
      setCaptureError(response.error);
      return;
    }

    // Window-entry fallback: persist state + close popup + rehydrate on return.
    await chrome.storage.session.set({
      cropPendingState: {
        tabId: tabIdRef.current,
        documentUrl,
        metadata,
        articleData,
        selectedTags,
        title,
        currentType,
        selectedVault: vaultRef.current,
        screenshotDataUrl,
        screenshotUploadId,
      },
    });

    const response = await requestCrop(null);
    if (!response.ok) {
      // The editor stays as it is; only the reason is added (Б4.6).
      await chrome.storage.session.remove("cropPendingState");
      if (mountedRef.current) setCaptureError(response.error);
      return;
    }

    window.close();
  }, [
    cropSupported,
    captureDocumentUrl,
    metadata,
    articleData,
    selectedTags,
    title,
    currentType,
    screenshotDataUrl,
    screenshotUploadId,
  ]);

  // Overlay context: listen for crop result event dispatched by content.js.
  // Every editor of the tab hears it; the crop this editor started is the
  // only one it takes, once (SPEC_AUDIT_FIXES.md, Г3.3).
  useEffect(() => {
    if (!IS_CONTENT_SCRIPT_CONTEXT) return;
    function onCropResult(e: Event) {
      const { detail } = e as CustomEvent<{ cropId?: string | null; dataUrl?: string; screenshotId?: string | null; error?: string }>;
      if (cropRequestRef.current === null || detail?.cropId !== cropRequestRef.current) return;
      cropRequestRef.current = null;
      if (detail.error) {
        // A refused crop keeps the previous frame (Б4.6).
        setCaptureError(detail.error);
        return;
      }
      if (detail.dataUrl && detail.screenshotId) {
        setCaptureError(null);
        setScreenshotDataUrl(detail.dataUrl);
        setScreenshotUploadId(detail.screenshotId);
      }
    }
    window.addEventListener("mine-crop-result", onCropResult);
    return () => window.removeEventListener("mine-crop-result", onCropResult);
  }, []);

  // --- Init ---

  useEffect(() => {
    init();
  }, []);

  async function init() {
    try {
      // chrome.action is a service-worker API and is not exposed to the
      // content-script isolated world where the overlay runs.
      if (chrome.action?.setBadgeText) {
        chrome.action.setBadgeText({ text: "" });
      }

      void ensureNativeStatus();

      // This opening and what it brought: an Instagram post already read,
      // a context-menu target. Only this clipper's source tab receives them.
      const launch = await getClipperLaunch();
      if (launch?.preloaded) {
        newCaptureRef.current = true;
        const { metadata: preMeta, article: preArticle } = launch.preloaded;
        tabIdRef.current = IS_CONTENT_SCRIPT_CONTEXT ? CONTENT_SCRIPT_CONTEXT : launch.sourceTabId;
        captureDocumentRef.current = IS_CONTENT_SCRIPT_CONTEXT ? window.location.href : launch.sourceUrl;

        setMetadataValue(preMeta as PageMetadata);
        setArticleDataValue(preArticle as ArticleData);
        setArticleExtractionStateValue(articleExtractionStateForResult(preArticle, preMeta));
        setTitle(preMeta.title ?? "");
        setCurrentType("content");
        setState("main");
        return;
      }

      // Check for crop mode result — popup was reopened after user finished cropping
      const cropData = await chrome.storage.session.get(["cropPendingState", "cropResult"]);
      if (cropData.cropPendingState && cropData.cropResult) {
        const pending = cropData.cropPendingState as {
          tabId: number;
          documentUrl?: string | null;
          metadata: PageMetadata | null;
          articleData: ArticleData | null;
          selectedTags: string[];
          title: string;
          currentType: ClipType;
          selectedVault: string | null;
          screenshotDataUrl: string | null;
          screenshotUploadId: string | null;
        };
        const result = cropData.cropResult as {
          status: "done" | "cancelled";
          dataUrl?: string;
          screenshotId?: string;
          error?: string;
        };

        chrome.storage.session.remove(["cropPendingState", "cropResult"]);

        tabIdRef.current = pending.tabId;
        captureDocumentRef.current = pending.documentUrl ?? null;
        vaultRef.current = pending.selectedVault;
        setSelectedVault(pending.selectedVault);
        setMetadataValue(pending.metadata);
        setArticleDataValue(pending.articleData);
        setArticleExtractionStateValue(
          pending.articleData
            ? articleExtractionStateForResult(pending.articleData, pending.metadata)
            : "idle",
        );
        setSelectedTags(pending.selectedTags);
        setTitle(pending.title);
        setCurrentType(pending.currentType);

        if (result.status === "done" && result.dataUrl) {
          setScreenshotDataUrl(result.dataUrl);
          setScreenshotUploadId(result.screenshotId ?? null);
        } else {
          // Cancelled — keep previous (un-cropped) screenshot, and say why
          // when the crop was refused (the page changed under it).
          setScreenshotDataUrl(pending.screenshotDataUrl);
          setScreenshotUploadId(pending.screenshotUploadId);
          if (result.error) setCaptureError(result.error);
        }

        // Re-check crop capability for the same tab (window-entry only —
        // content-script overlay doesn't use this rehydrate path at all)
        let tabUrl: string | null = null;
        if (!IS_CONTENT_SCRIPT_CONTEXT && pending.tabId !== null && chrome.tabs?.get) {
          const t = await chrome.tabs.get(pending.tabId).catch(() => null);
          tabUrl = t?.url ?? null;
        }
        applyCropCapability(tabUrl);

        setState("main");
        return;
      }

      const ctxData = launch?.contextMenu ?? null;
      if (ctxData) newCaptureRef.current = true;

      // Resolve the target tab: in content-script context we ARE the tab,
      // so we use the sentinel tabId and read URL/title from window+document.
      // The detached window works for the tab it was opened for, never for
      // whatever tab is active when it asks (its own window's tab is the
      // clipper itself).
      let tabId: number;
      let tabUrl: string | undefined;
      let tabTitle: string | undefined;
      if (IS_CONTENT_SCRIPT_CONTEXT) {
        tabId = CONTENT_SCRIPT_CONTEXT;
        tabUrl = window.location.href;
        tabTitle = document.title;
      } else {
        if (!launch) {
          showError("Open Mine again from the page you want to save");
          return;
        }
        tabId = launch.sourceTabId;
        tabUrl = launch.sourceUrl ?? undefined;
        tabTitle = launch.sourceTitle ?? undefined;
      }
      tabIdRef.current = tabId;
      captureDocumentRef.current = tabUrl ?? null;
      applyCropCapability(tabUrl ?? null);

      // "Save link" clips the link, never the page it was clicked on: nothing
      // is read from that page (SPEC_AUDIT_FIXES.md, Ф5, Ф6, В4.2).
      const linkTarget = ctxData?.menuItemId === "save-link" && ctxData.linkUrl ? ctxData.linkUrl : null;
      const meta = linkTarget ? linkTargetMetadata(linkTarget) : await extractMetadata(tabId);
      let article: ArticleData = { title: "", content: "", byline: null, excerpt: "" };

      // Apply tab fallbacks; the tab's address and title are another page's
      // for a link target.
      if (!linkTarget) {
        if (!meta.url && tabUrl) meta.url = tabUrl;
        if (!meta.title && tabTitle) meta.title = tabTitle;
      }

      // Apply context menu overrides
      if (ctxData) {
        await applyContextMenu(ctxData, meta, tabId);
      }

      // Twitter/X photo lightbox (/status/<id>/photo/<n>): clip the single
      // image the overlay shows, not the whole tweet thread. tabUrl is the raw
      // location (meta.url is canonicalized to /status/<id> without the photo
      // suffix). Skip when the context menu already resolved an explicit type
      // or named a link, whose clip is not the photo the tab shows.
      if (
        !linkTarget &&
        meta.detectedType !== "image" &&
        meta.detectedType !== "selection" &&
        tabUrl
      ) {
        const photo = await resolveTwitterPhotoLightbox(tabUrl, tabId);
        if (photo) {
          meta.detectedType = "image";
          meta.imageToSave = photo.src;
          meta.url = pickImageCardUrl({ pageUrl: tabUrl, srcUrl: photo.src });
          if (photo.alt) meta.imageAlt = photo.alt;
          if (photo.width) meta.imageWidth = photo.width;
          if (photo.height) meta.imageHeight = photo.height;
        }
      }

      setMetadataValue(meta);
      // If save-link fetched tweet data via syndication API, use it
      if (deferredArticleRef.current) {
        article = deferredArticleRef.current;
        if (article.title) meta.title = article.title;
        deferredArticleRef.current = null;
      }
      setArticleDataValue(article);
      setArticleExtractionStateValue(articleHasSaveableContent(meta, article) ? "ready" : "idle");
      setTitle(meta.title ?? "");

      // Map detected type. Precedence (see SPEC_CLIPPER.md § Auto-detection):
      //   selection  → Content (quote takes over the preview via resolveContentBody)
      //   image      → Image-only view (TypeSwitcher hidden in PopupApp)
      //   article    → Content
      //   video      → Content (video block, transcript in body)
      //   Save link  → Link, with no screenshot: the tab shows another page
      //   link/other → Screenshot (default visual clip for everything else)
      let detected: ClipType;
      const dt = meta.detectedType;
      if (dt === "selection" || dt === "article" || dt === "content" || dt === "video") {
        detected = "content";
      } else if (dt === "image") {
        detected = "image";
      } else if (linkTarget) {
        detected = "link";
      } else {
        detected = "screenshot";
      }
      setCurrentType(detected);
      if (detected === "screenshot") {
        captureScreenshot();
      }

      setState("main");

      // Background: content extraction can be expensive on DOM-heavy pages.
      // Never block initial popup paint on Defuddle; hydrate the preview/body
      // after the clipper is already usable.
      if (detected === "content" && contentModeNeedsArticleExtraction(meta)) {
        void ensureArticleLoaded();
      }
    } catch (e) {
      showError("Failed to initialize: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function applyCropCapability(url: string | null) {
    if (!url) {
      setCropSupported(false);
      return;
    }
    try {
      const u = new URL(url);
      // Content scripts only run on http/https/file — everything else (chrome://,
      // chrome-extension://, chrome.google.com/webstore, view-source:) is off-limits.
      if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") {
        if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) {
          setCropSupported(false);
          return;
        }
        setCropSupported(true);
        return;
      }
      setCropSupported(false);
    } catch {
      setCropSupported(false);
    }
  }

  async function applyContextMenu(ctx: ContextMenuData, meta: PageMetadata, tabId: number) {
    switch (ctx.menuItemId) {
      case "save-image": {
        applySaveImageContextMenu(ctx, meta);
        let domPostUrl: string | null = null;
        if (ctx.srcUrl) {
          try {
            const info = await getImageInfo(tabId, ctx.srcUrl);
            if (info.alt) meta.imageAlt = info.alt;
            if (info.width) meta.imageWidth = info.width;
            if (info.height) meta.imageHeight = info.height;
            domPostUrl = info.postUrl ?? null;
          } catch {
            // Optional — ignore
          }
        }
        // The card links to the publication, not to the image file: the file
        // is what gets downloaded, the post is what the link is for.
        meta.url = pickImageCardUrl({
          domPostUrl,
          pageUrl: ctx.pageUrl,
          srcUrl: ctx.srcUrl,
        });
        break;
      }
      case "save-selection":
        meta.detectedType = "selection";
        meta.selection = ctx.selectionText ?? meta.selection;
        break;
      case "save-link":
        // The metadata is already the link's own (linkTargetMetadata).
        // Twitter/X tweet links: fetch full tweet (text + images) via
        // syndication API directly from popup — no content script needed,
        // works even when current page is the feed, not the tweet page.
        if (ctx.linkUrl && /(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i.test(ctx.linkUrl)) {
          meta.detectedType = "article";
          const tweetMatch = ctx.linkUrl.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i);
          if (tweetMatch) {
            const [, handle, tweetId] = tweetMatch;
            try {
              const tweet = await fetchTweetBySyndicationApi(tweetId!, `@${handle}`);
              if (tweet) {
                deferredArticleRef.current = { ...tweet, sourceUrl: meta.url };
              }
            } catch {
              // Fall through — save as article without media
            }
          }
        }
        break;
      case "save-page": {
        // Twitter lightbox: user right-clicked on the overlay image but
        // Chrome didn't detect an <img> context (transparent element on
        // top). Check if a lightbox is open and extract the image URL.
        const pageUrl = meta.url || "";
        if (pageUrl.includes("x.com/") || pageUrl.includes("twitter.com/")) {
          try {
            const lightbox = await detectTwitterLightbox(tabId);
            if (lightbox?.src) {
              meta.detectedType = "image";
              meta.imageToSave = lightbox.src;
              if (lightbox.alt) meta.imageAlt = lightbox.alt;
              if (lightbox.width) meta.imageWidth = lightbox.width;
              if (lightbox.height) meta.imageHeight = lightbox.height;
              // The lightbox belongs to a publication; the card should link
              // to it rather than to the profile the lightbox opened over.
              let domPostUrl: string | null = null;
              try {
                domPostUrl = (await getImageInfo(tabId, lightbox.src)).postUrl ?? null;
              } catch {
                // Optional — ignore
              }
              const postUrl = pickImageCardUrl({
                domPostUrl,
                pageUrl,
                srcUrl: "",
              });
              if (postUrl) meta.url = postUrl;
            }
          } catch {
            // Fall through to default page save
          }
        }
        break;
      }
    }
  }

  function showError(msg: string) {
    setError(msg);
    setState("error");
  }

  // --- Actions ---

  const toggleTag = useCallback((tag: string) => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    editorChangedRef.current = true;
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, [setSelectedTags]);

  const createChannel = useCallback(async (name: string) => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    editorChangedRef.current = true;
    const generation = destinationGenerationRef.current;
    const mode = saveModeRef.current;
    const vault = vaultRef.current;
    const binding = bindingIdRef.current;
    const isCurrent = () => mountedRef.current && generation === destinationGenerationRef.current
      && mode === saveModeRef.current && vault === vaultRef.current && binding === bindingIdRef.current
      && !operationRef.current && !preparedOperationRef.current && !savingRef.current;
    setCollectionError(null);
    // The folder chosen now is where the collection goes, even if another
    // one is chosen while the request runs (SPEC_AUDIT_FIXES.md, Ф6).
    const result = mode === "standalone"
      ? await standaloneCreateChannel(name, binding)
      : await sendToNative({ action: "create_channel", tag: name, vault_path: vault });
    if (!isCurrent()) return;
    if (!result.ok) {
      // A failed collection is not a failed clip: the editor, its Save and
      // the collection name stay for another try.
      setCollectionError(result.error ?? "Could not create the collection");
      return;
    }
    const tag = typeof result.tag === "string" ? result.tag : name;
    await refreshChannels();
    if (!isCurrent()) return;
    setSelectedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  }, [refreshChannels, setSelectedTags]);

  /// A Save has ended: a destination check held back during it runs now (Г3.2).
  const endSaving = useCallback(() => {
    savingRef.current = false;
    saveDestinationHeldRef.current = false;
    setSaving(false);
    if (!recheckAfterSaveRef.current) return;
    recheckAfterSaveRef.current = false;
    if (mountedRef.current) void ensureNativeStatus(true);
  }, [ensureNativeStatus]);

  const save = useCallback(async () => {
    if (!metadata || savingRef.current || (currentType === "screenshot" && capturingRef.current)) return;

    savingRef.current = true;
    setSaving(true);
    // Folder moves seen when Save was pressed. A move before the clip is
    // written takes the collections away from it: the Save stops and the
    // editor names both folders, as В4.4 has it (Г3.2).
    const movesWhenPressed = destinationMoveRef.current;
    try {
    await negotiateWidgetProtocol();
    const pending = operationRef.current ?? preparedOperationRef.current;
    if (pending) {
      if (pending.terminalResult?.ok || pending.terminalResult?.outcome === "committed") {
        return { ok: true as const, warning: pending.terminalResult.warning };
      }
      if (preparedOperationRef.current === pending) {
        await persistPendingSave(pending);
        preparedOperationRef.current = null;
        setSavePrepared(false);
      }
      operationRef.current = pending;
      setPendingOperation(true);
      const result = await executePinnedSave(pending);
      if (result.ok || result.outcome === "committed") {
        return confirmSavedOperation(pending, result);
      }
      if (result.outcome === "not_committed" && result.terminal_rejected === true) {
        await clearPendingSave(pending);
        operationRef.current = null;
        setPendingOperation(false);
        return { ok: false as const, error: result.error ?? "This save was rejected before writing any files. You can edit the clip and try again." };
      }
      return { ok: false as const, error: "Could not confirm the save. Please retry." };
    }
    const previous = previousOperation ?? await findPendingSave(
      resolveCaptureResult(currentType, metadata, articleDataRef.current).sourceUrl,
    );
    if (previous && !allowDifferentDraft) {
      setPreviousOperation(previous);
      return { ok: false as const, error: "A previous clip from this page has an unresolved save. Review that clip first; checking it does not save this new draft." };
    }
    // A browser folder saves without asking the helper first (А3.11).
    if (saveModeRef.current !== "standalone" && !(await ensureNativeStatus())) {
      setSaving(false);
      return {
        ok: false as const,
        error: nativeStatusErrorRef.current ?? "Cannot connect to Mine",
      };
    }
    const saveMetadata = metadata;
    if (currentType === "content" && contentModeNeedsArticleExtraction(saveMetadata)) {
      await ensureArticleLoaded();
    }
    // A destination check still out, such as the one a restored draft starts,
    // decides where the clip goes before Save reads it.
    while (nativeStatusPromiseRef.current) await nativeStatusPromiseRef.current;
    if (destinationMoveRef.current !== movesWhenPressed) {
      return { ok: false as const, error: DESTINATION_CHANGED_DURING_SAVE };
    }
    if (saveModeRef.current === "unconfigured") {
      return { ok: false as const, error: nativeStatusErrorRef.current ?? "Choose a folder before saving." };
    }
    if (!bindingIdRef.current) {
      return { ok: false as const, error: "The selected folder has no verified save binding. Choose it again before saving." };
    }
    // One snapshot after the last wait: where the clip goes and the
    // collections it carries. No check moves the editor from here on.
    saveDestinationHeldRef.current = true;
    const chosenExecutor = saveModeRef.current === "standalone" ? "browser" : "native";
    const chosenBinding = bindingIdRef.current;
    const chosenVault = chosenExecutor === "browser" ? null : vaultRef.current;
    const chosenFolderLabel = chosenExecutor === "browser" ? destinationLabelRef.current ?? "Folder" : chosenVault ?? undefined;
    const chosenTags = selectedTagsRef.current;
    const capture = resolveCaptureResult(currentType, saveMetadata, articleDataRef.current);

    let blockType: string;
    if (currentType === "content") {
      blockType = saveMetadata.detectedType === "video" ? "video" : "article";
    } else if (currentType === "image" || currentType === "screenshot") blockType = "image";
    else blockType = currentType;

    const payload: NativeRequest = {
      action: "save_block",
      vault_path: chosenVault,
      block_type: blockType,
      title: title || null,
      description: null,
      url: capture.sourceUrl || null,
      body: "",
      tags: chosenTags.length > 0 ? chosenTags : null,
      image_url: null,
      author: saveMetadata.author || null,
      width: null,
      height: null,
    };

    if (currentType === "content") {
      const resolved = capture.body;
      if (!resolved.text.trim()) {
        setSaving(false);
        return {
          ok: false as const,
          error: emptyContentMessage(saveMetadata, articleExtractionStateRef.current),
        };
      }
      payload.body = resolved.text;
      // Both executors save a selection as shown (SPEC_AUDIT_FIXES.md, Ф5).
      if (resolved.source === "selection") payload.selection = true;
      if (resolved.source === "article" && resolved.byline) {
        payload.author = resolved.byline;
      }
      // Posters travel with the body so the host can fall back to one when a
      // video turns out to be too large to store. They cost nothing when every
      // video saves normally, and the popup is the only place that knows them.
      const posters = (articleDataRef.current?.embeddedVideos ?? [])
        .filter((video) => video.src && video.poster)
        .map((video) => ({ video_url: video.src!, poster_url: video.poster! }));
      if (posters.length > 0) {
        payload.video_posters = posters;
      }

    } else if (currentType === "link") {
      payload.body = buildLinkBody(title);
    }

    if (currentType === "screenshot" && chosenExecutor === "browser") {
      if (!screenshotDataUrl) {
        setSaving(false);
        return { ok: false as const, error: "Screenshot not captured yet" };
      }
      payload.screenshot_data_url = screenshotDataUrl;
    } else if (currentType === "screenshot") {
      // On any screenshot-path failure we return an inline error instead
      // of calling showError: the popup stays in "main" state, the status
      // bar surfaces the message, and the user can press Save again
      // (or Retake) without losing the captured screenshot, the tags
      // they already picked, or the selected vault. Prior behaviour
      // toggled `state = "error"` which replaced the entire UI with
      // ErrorState and forced a reopen.
      if (!screenshotDataUrl) {
        setSaving(false);
        return { ok: false as const, error: "Screenshot not captured yet" };
      }
      let uploadId = screenshotRef.current.dataUrl === screenshotDataUrl ? screenshotRef.current.uploadId : null;
      if (!uploadId) {
        uploadId = await cacheScreenshotUpload(screenshotDataUrl);
        if (screenshotRef.current.dataUrl === screenshotDataUrl) setScreenshotUploadId(uploadId);
      }
      if (!uploadId) {
        setSaving(false);
        return {
          ok: false as const,
          error: "Screenshot upload expired. Retake the screenshot and try again.",
        };
      }
      if (!uploadPortRef.current || !uploadTokenRef.current) {
        setSaving(false);
        return { ok: false as const, error: "Upload server not configured" };
      }
      if (!supportsPendingUploadsRef.current) {
        setSaving(false);
        return {
          ok: false as const,
          error: "Native host needs update before screenshots can be saved safely.",
        };
      }
      try {
        const blob = await fetch(screenshotDataUrl).then((r) => r.blob());
        const ext = blob.type === "image/png" ? "png" : "jpg";
        const filename = `${(title || "screenshot").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60)}.${ext}`;
        let uploadResult = await uploadFile(
          uploadPortRef.current,
          uploadTokenRef.current,
          filename,
          uploadId,
          chosenVault,
        );
        if (!uploadResult.ok && uploadResult.error === "Screenshot upload expired") {
          const refreshedUploadId = await cacheScreenshotUpload(screenshotDataUrl);
          if (screenshotRef.current.dataUrl === screenshotDataUrl) setScreenshotUploadId(refreshedUploadId);
          if (refreshedUploadId) {
            uploadResult = await uploadFile(
              uploadPortRef.current,
              uploadTokenRef.current,
              filename,
              refreshedUploadId,
              chosenVault,
            );
          }
        }
        if (uploadResult.ok && uploadResult.upload_id) {
          payload.pre_uploaded_id = uploadResult.upload_id;
        } else if (uploadResult.ok && uploadResult.filename?.startsWith("pending:")) {
          payload.pre_uploaded_file = uploadResult.filename;
        } else {
          setSaving(false);
          return {
            ok: false as const,
            error: uploadResult.ok
              ? "Upload failed: native host did not return a recoverable upload id"
              : `Upload failed: ${uploadResult.error ?? "unknown"}`,
          };
        }
      } catch (e) {
        setSaving(false);
        return {
          ok: false as const,
          error: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    } else if (currentType === "image") {
      // Image block requires a media source. Prefer the curated
      // imageToSave (content script picked it from the page's best
      // candidate), fall back to the og:image the preview already
      // shows, otherwise refuse the save to prevent a frontmatter
      // without `file:` / `image_url` — which previously created an
      // orphaned .md that never rendered in the feed.
      const imageUrl = capture.kind === "image" ? capture.imageUrl : null;
      if (!imageUrl) {
        setSaving(false);
        return {
          ok: false as const,
          error: "No image available — pick another type or capture a screenshot.",
        };
      }
      payload.image_url = imageUrl;
      payload.width = saveMetadata.imageWidth ?? null;
      payload.height = saveMetadata.imageHeight ?? null;
    } else if (saveMetadata.image && (currentType === "link" || saveMetadata.detectedType === "video")) {
      payload.image_url = saveMetadata.image;
    }

    const operation: PinnedSaveOperation = {
      id: crypto.randomUUID(),
      draftId,
      draftRevision: draftRevisionRef.current,
      sourceUrl: capture.sourceUrl,
      folderLabel: chosenFolderLabel,
      executor: chosenExecutor,
      bindingId: chosenBinding,
      vaultPath: chosenVault,
      // saved_at is the local wall clock without a zone, shared by both
      // executors. A helper that has not declared this form gets no saved_at
      // and stamps the card itself (К4).
      payload: baselineSaveRequest(
        chosenExecutor === "browser" || nativeFeaturesRef.current.includes("local_saved_at_v1")
          ? { ...payload, saved_at: localSavedAt() }
          : payload,
        chosenExecutor === "browser" ? 1 : saveProtocolRef.current ?? 1,
      ),
      attempted: false,
    };
    // A failed readback may follow a successful journal write. Keep this exact
    // live snapshot for confirmation, without treating it as dispatched.
    preparedOperationRef.current = operation;
    setSavePrepared(true);
    await persistPendingSave(operation);
    preparedOperationRef.current = null;
    setSavePrepared(false);
    operationRef.current = operation;
    setPendingOperation(true);
    const result = await executePinnedSave(operation);
    if (result.ok || result.outcome === "committed") {
      return confirmSavedOperation(operation, result);
    }
    if (result.outcome === "not_committed" && result.terminal_rejected === true) {
      await clearPendingSave(operation);
      operationRef.current = null;
      setPendingOperation(false);
      return { ok: false as const, error: result.error ?? "This save was rejected before writing any files. You can edit the clip and try again." };
    }
    return { ok: false as const, error: "Could not confirm the save. Please retry." };
    } catch (cause) {
      return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      endSaving();
    }
  }, [
    metadata,
    currentType,
    title,
    ensureArticleLoaded,
    ensureNativeStatus,
    endSaving,
    setMetadataValue,
    screenshotDataUrl,
    screenshotUploadId,
    previousOperation,
    allowDifferentDraft,
    draftId,
    confirmSavedOperation,
    draftSourceUrl,
  ]);

  const switchVault = useCallback(async (vaultPath: string) => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    editorChangedRef.current = true;
    destinationRef.current = "native";
    destinationGenerationRef.current += 1;
    // An error from the previous space does not follow the switch (К3).
    nativeStatusErrorRef.current = null;
    setNativeStatusError(null);
    setChannelsLoading(true);
    setChannelsError(null);
    destinationMoveRef.current += 1;
    setSelectedTags([]);
    setDestinationNotice(null);
    bindingIdRef.current = null;
    destinationLabelRef.current = vaultPath;
    setSelectedVault(vaultPath);
    vaultRef.current = vaultPath;
    // A reachable space loads its collections from the status itself.
    await ensureNativeStatus(true);
  }, [ensureNativeStatus, setSelectedTags]);

  /// Desktop parity for the space switcher: the host shows the system folder
  /// chooser, registers the folder in the shared config, and the clipper
  /// switches to it — the same flow Add space runs in the app.
  const addSpace = useCallback(async () => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
    try {
      const resp = await pickVaultFolder();
      if (!resp.ok) throw new Error(resp.error ?? "The Mine helper could not choose a folder");
      if (resp.cancelled || !resp.path) return;
      setKnownVaults(resp.vaults);
      await chrome.storage.local.set({ mineKnownVaults: resp.vaults });
      await switchVault(resp.path);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      nativeStatusErrorRef.current = message;
      setNativeStatusError(message);
    }
  }, [switchVault]);

  /// Reveal answers either way (К6): the host opens where the space is now,
  /// found by identity, or says why it cannot.
  const revealSpace = useCallback(async (vaultPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const binding = vaultPath === vaultRef.current && destinationRef.current === "native" ? bindingIdRef.current : null;
    const result = await revealVault(vaultPath, binding);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Finder could not show this space." };
  }, []);

  const chooseFolder = useCallback(async () => {
    if (operationRef.current || preparedOperationRef.current || savingRef.current) return { ok: false as const, error: "Resolve the pending save before changing its folder." };
    if (!canPickFolderHere()) return openStandaloneSetup();
    const status = await chooseStandaloneFolder();
    if (status.configured && status.permission === "granted") {
      editorChangedRef.current = true;
      await chrome.storage.local.set({ mineSaveDestination: { executor: "browser", bindingId: status.bindingId } });
      enterStandaloneMode(status, "chosen");
      return { ok: true as const };
    }
    return { ok: false as const, error: status.error ?? null };
  }, [enterStandaloneMode]);

  const regrantFolder = useCallback(async () => {
    const bindingId = operationRef.current?.executor === "browser" ? operationRef.current.bindingId : undefined;
    if (!canPickFolderHere()) return openStandaloneSetup(bindingId);
    const status = await regrantStandaloneAccess(bindingId);
    if (status.configured && status.permission === "granted") {
      if (!operationRef.current) enterStandaloneMode(status);
      return { ok: true as const };
    }
    return { ok: false as const, error: status.error ?? null };
  }, [enterStandaloneMode]);

  return {
    state,
    error,
    metadata,
    articleData,
    channels,
    channelsLoading,
    channelsError,
    channelsNotice,
    collectionError,
    retryChannels: () => { void refreshChannels(); },
    selectedTags,
    currentType,
    setCurrentType: handleTypeChange,
    screenshotDataUrl,
    retakeScreenshot,
    startCropMode,
    cropSupported,
    /** A screenshot request is in flight; Retake and Crop wait for it. */
    capturing,
    /** Why the last screenshot or crop failed; the editor and its frame stay. */
    captureError,
    title,
    setTitle: (value: string) => {
      if (operationRef.current || preparedOperationRef.current || savingRef.current) return;
      editorChangedRef.current = true;
      setTitle(value);
    },
    saving,
    // A screenshot waits for the frame being taken (В4.5); every clip waits
    // while its destination is checked, which may move it to another folder
    // and take its collections (Г3.2). The asking again every few seconds
    // while Mine is out of reach does not blink the button: Save waits for
    // that check itself and stops if it moved the clip.
    canSave: state === "main" && metadata !== null && !(currentType === "screenshot" && capturing)
      && !(connectionChecking && !reconnecting),
    /** Where the draft was made and where Save now puts it, when they differ. */
    destinationNotice,
    draftReady: Boolean(draftSourceUrl && draftReadySource === draftSourceUrl),
    draftLoading: Boolean(draftSourceUrl && draftReadySource !== draftSourceUrl && !draftError),
    draftError,
    connectionChecking,
    reconnecting,
    articleExtractionState,
    nativeStatusError,
    nativeConnected,
    canOpenApp,
    pendingOperation,
    savePinned: pendingOperation || savePrepared,
    previousOperation,
    recoverPreviousSave,
    restorePreviousFolder,
    allowDifferentDraft,
    confirmDifferentDraft: () => setAllowDifferentDraft(true),
    retryConnection: ensureNativeStatus,
    toggleTag,
    createChannel,
    save,
    knownVaults,
    selectedVault,
    switchVault,
    addSpace,
    revealSpace,
    saveMode,
    standaloneFolder,
    canPickFolder: canPickFolderHere(),
    chooseFolder,
    regrantFolder,
  };
}

interface TwitterMediaPreview {
  kind: "image" | "video" | string;
  src: string;
  poster?: string | null;
  media_type?: string;
}

interface ResolveTwitterMediaResponse {
  ok: boolean;
  error?: string;
  media?: TwitterMediaPreview[];
}

/** The crop of content.js in this page; the overlay shares its world. */
interface PageCrop {
  start: (documentUrl: string | null, cropId: string) => void;
  /** Absent in a page whose content script predates named crops. */
  cancel?: (cropId: string) => void;
}

function pageCrop(): PageCrop | undefined {
  return (globalThis as unknown as { __mineCrop?: PageCrop }).__mineCrop;
}

/// One line naming both folders when a draft is saved elsewhere than where it
/// was made. A space is named by its folder, not by its whole path.
function movedDraftNotice(previousLabel: string | null, folderName: string): string {
  const segments = previousLabel?.split("/").filter(Boolean) ?? [];
  const previous = segments[segments.length - 1] ?? previousLabel;
  return previous
    ? `This draft was made for “${previous}”. It will be saved to “${folderName}”.`
    : `This draft was made for another folder. It will be saved to “${folderName}”.`;
}

function isRecoverableDraftError(cause: unknown): boolean {
  return cause instanceof DraftStorageError
    && (cause.code === "draft_transport" || cause.code === "draft_storage_failed" || cause.code === "draft_not_confirmed");
}

async function confirmDraftMutation(mutation: { sourceUrl: string; draft: DurableClipperDraft; expectedRevision: number; ownership: DraftOwnership }): Promise<DurableClipperDraft> {
  try {
    return await writeOwnedDraft(mutation.sourceUrl, mutation.draft, mutation.expectedRevision, mutation.ownership);
  } catch (cause) {
    if (!isRecoverableDraftError(cause)) throw cause;
    // Replay the same identity and payload, never a replacement write.
    return writeOwnedDraft(mutation.sourceUrl, mutation.draft, mutation.expectedRevision, mutation.ownership);
  }
}

function isTwitterStatusUrl(url: string | null | undefined): boolean {
  return /(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i.test(url ?? "");
}

function firstEmbeddedVideoCurrentTime(article: ArticleData): number {
  for (const video of article.embeddedVideos ?? []) {
    const currentTime = video.currentTime;
    if (typeof currentTime === "number" && Number.isFinite(currentTime) && currentTime >= 0) {
      return currentTime;
    }
  }
  return 0.2;
}

function drawVideoFrameDataUrl(video: HTMLVideoElement): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const maxWidth = 640;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } catch {
    return null;
  }
}

function captureVideoUrlFrameDataUrl(
  src: string,
  targetTime: number,
  timeoutMs = 650,
): Promise<string | null> {
  if (!/\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(src)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    let done = false;
    let waitingForSeek = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const draw = () => finish(drawVideoFrameDataUrl(video));
    const onSeeked = () => draw();
    const onLoadedData = () => {
      if (!waitingForSeek) draw();
    };
    const onError = () => finish(null);
    const onMetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const requestedTime = Number.isFinite(targetTime) ? targetTime : 0.2;
      const seekTime = duration > 0
        ? Math.min(Math.max(requestedTime, 0), Math.max(duration - 0.05, 0))
        : Math.max(requestedTime, 0);
      if (seekTime <= 0.01) return draw();
      try {
        waitingForSeek = true;
        video.currentTime = seekTime;
      } catch {
        draw();
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    // One frame is all the preview needs. "auto" let the browser pull the
    // whole file (26 MB for a 2160p post) on the same link the save is about
    // to download it over; "metadata" plus the seek fetches only the range
    // around the frame.
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = src;
    video.load();
  });
}

async function hydrateTwitterVideoPreviews(
  metadata: PageMetadata,
  article: ArticleData,
): Promise<ArticleData> {
  if (!isTwitterStatusUrl(metadata.url)) return article;

  if (article.twitterPosts) {
    return hydrateTwitterPosts(article, {
      publicMedia: (tweetId) => sendToNative({ action: "resolve_twitter_media", tweet_id: tweetId }),
      authenticatedMedia: (tweetId) => chrome.runtime.sendMessage({
        target: "background", action: "resolveAuthenticatedTweetVideo",
        payload: { tweetUrl: `https://x.com/i/status/${tweetId}`, tweetId },
      }),
      frame: (src) => captureVideoUrlFrameDataUrl(src, firstEmbeddedVideoCurrentTime(article)),
    });
  }

  let response = await sendToNative({
    action: "resolve_twitter_media",
    url: metadata.url,
  }) as ResolveTwitterMediaResponse;

  // Age-restricted posts: the public API answers with a tombstone and the page
  // keeps the video behind a blob: URL, so the content script flagged it. Only
  // the background script can read the session cookies, so the retry goes
  // through it. Done here rather than at save time so the preview shows the
  // real video too, and both paths stay on one source.
  const publicHasVideo =
    response.ok
    && Array.isArray(response.media)
    && response.media.some((media) => media.kind === "video" && media.src);
  if (!publicHasVideo && article.needsAuthenticatedVideo) {
    const authenticated = await chrome.runtime.sendMessage({
      target: "background",
      action: "resolveAuthenticatedTweetVideo",
      payload: { tweetUrl: article.tweetUrl ?? metadata.url, tweetId: article.tweetId },
    }) as ResolveTwitterMediaResponse | undefined;
    if (authenticated?.ok && Array.isArray(authenticated.media)) {
      response = authenticated;
    }
  }

  if (!response.ok || !Array.isArray(response.media)) return article;

  const currentTime = firstEmbeddedVideoCurrentTime(article);
  const videos = await Promise.all(
    response.media
      .filter((media) => media.kind === "video" && media.src)
      .map(async (media) => {
        const capturedPoster =
          media.media_type === "animated_gif"
            ? await captureVideoUrlFrameDataUrl(media.src, currentTime)
            : null;
        return {
          src: media.src,
          poster: capturedPoster ?? media.poster ?? null,
          title: "Tweet video preview",
          currentTime,
        };
      }),
  );

  if (videos.length === 0) return article;

  // Previews alone are not enough: the native host downloads media by reading
  // `![](url)` out of the body. For ordinary tweets those links come from the
  // public API, which builds the body itself — but an age-restricted post never
  // reaches that branch, so its body arrives as bare text and the video would
  // be previewed and then dropped.
  let content = article.content;
  if (article.needsAuthenticatedVideo) {
    const missing = videos
      .map((video) => video.src)
      .filter((src): src is string => !!src && !content.includes(src));
    if (missing.length > 0) {
      const embeds = missing.map((src) => `![](${src})`).join("\n\n");
      content = content ? `${content}\n\n${embeds}` : embeds;
    }
  }

  return {
    ...article,
    content,
    embeddedVideos: videos,
  };
}

// ─── Twitter syndication API (direct fetch, no content script) ──────────

interface SyndicationMedia {
  type: string;
  url?: string;
  media_url_https?: string;
  video_info?: { variants?: { content_type: string; bitrate?: number; url: string }[] };
}

function stripSyndicationMediaLinks(text: string, mediaDetails: SyndicationMedia[]): string {
  let cleaned = text;
  for (const media of mediaDetails) {
    const shortUrl = media.url?.trim();
    if (shortUrl) {
      cleaned = cleaned.replaceAll(shortUrl, "");
    }
  }
  return cleaned.trim();
}

async function fetchTweetBySyndicationApi(
  tweetId: string,
  authorHandle: string,
): Promise<ArticleData | null> {
  const resp = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`,
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  const mediaDetails = (data.mediaDetails ?? []) as SyndicationMedia[];

  const text = stripSyndicationMediaLinks(data.text ?? "", mediaDetails);
  const media: string[] = [];

  for (const m of mediaDetails) {
    if (m.type === "photo" && m.media_url_https) {
      media.push(m.media_url_https + "?name=large");
    } else if ((m.type === "video" || m.type === "animated_gif") && m.video_info?.variants) {
      const best = m.video_info.variants
        .filter((v) => v.content_type === "video/mp4" && v.bitrate != null)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (best[0]) media.push(best[0].url);
    }
  }

  const parts: string[] = [];
  if (text) parts.push(text);
  for (const src of media) {
    parts.push(`![](${src})`);
  }

  if (parts.length === 0) return null;

  const title = text.replace(/\n/g, " ").trim().slice(0, 80) || authorHandle;
  return {
    title,
    content: parts.join("\n\n"),
    byline: authorHandle,
    excerpt: text.slice(0, 200),
  };
}

// Resolve the single image addressed by a Twitter/X "/status/<id>/photo/<n>"
// URL. Prefer the syndication API (full-res, indexed by /photo/n, no lazy-DOM
// dependency); fall back to DOM lightbox detection if the API is unavailable.
async function resolveTwitterPhotoLightbox(
  rawUrl: string,
  tabId: number,
): Promise<ResolvedLightboxImage | null> {
  const target = parseTwitterPhotoUrl(rawUrl);
  if (!target) return null;
  try {
    const photo = await fetchTweetPhotoByIndex(target.tweetId, target.photoIndex);
    if (photo) return photo;
  } catch {
    // Syndication unavailable — fall through to DOM detection.
  }
  try {
    const lightbox = await detectTwitterLightbox(tabId);
    if (lightbox?.src) {
      return {
        src: lightbox.src,
        alt: lightbox.alt ?? null,
        width: lightbox.width ?? null,
        height: lightbox.height ?? null,
      };
    }
  } catch {
    // Both sources failed — caller keeps the original detected type.
  }
  return null;
}
