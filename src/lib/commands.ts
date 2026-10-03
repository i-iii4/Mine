// Tauri IPC wrappers. Thin typed layer over invoke().
// Each function maps 1:1 to a #[tauri::command] in Rust.

import {
  invoke as tauriInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";
import type {
  SidebarLayout,
  TabBarState,
  TabBootstrap,
  TabId,
  TabView,
  IndexedBlock,
  GridSnapshot,
  FeedOrder,
  SearchPageToken,
  SearchSnapshot,
  GraphSnapshot,
  GraphOptions,
  GraphScope,
  LightBlock,
  DeleteBlockPlan,
  RenameBlockError,
  RenameBlockResult,
  TagCount,
  ChannelDto,
  ChannelPreviewsSnapshot,
  TaxonomySnapshot,
  VaultStats,
  VaultOpenResult,
  VaultWriteLayoutDto,
  UnavailableVault,
  SpaceEntry,
  ClipboardPayload,
  ShortcutBinding,
  CreateBlockParams,
  ArenaChannelInfo,
  ImportChannelRequest,
  ImportChannelResult,
  ArticleAudioState,
  CreateMediaAssetCardParams,
  DeleteMediaAssetPlan,
  ExtractInlineMediaParams,
  InlineMediaExtractError,
  MediaAssetActionError,
  MediaAssetMutationResult,
  RenameMediaAssetParams,
  RemoveMediaAssetFromCardParams,
  DeleteTextSelectionParams,
  ExtractTextSelectionParams,
  MergeBlocksError,
  MergeBlocksResult,
  TextSelectionExtractError,
  OrphanMediaList,
  OrphanMediaBatchRequest,
  PromoteOrphanResult,
  DeleteOrphanResult,
  SpaceStats,
  NativeShellSmokeReport,
  CommandError,
  IcloudDownloadProgress,
  CloudRecommendationState,
  UpdateStatus,
} from "@/types";

function isCommandError(error: unknown): error is CommandError {
  if (!error || typeof error !== "object" || !("kind" in error)) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === "no_vault"
    || kind === "space_changed"
    || kind === "source_changed"
    || kind === "frontmatter_not_writable"
    || kind === "space_identity_unreadable"
    || kind === "internal";
}

/// The note's name for a message: the last segment of its path.
function noteName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function commandErrorMessage(error: CommandError): string {
  switch (error.kind) {
    case "no_vault":
      return "no vault selected";
    case "space_changed":
      return "the open space changed; refresh and try again";
    case "source_changed":
      return `“${noteName(error.message.path)}” changed outside Mine; nothing was changed. Try again.`;
    case "frontmatter_not_writable":
      return `The properties of “${noteName(error.message.path)}” are written in a form Mine cannot edit in place; nothing was changed.`;
    case "space_identity_unreadable":
      return `Mine cannot read the identity file of “${noteName(error.message.path)}”, so it did not open the space and changed nothing. Check access to the folder, or wait until iCloud downloads it.`;
    case "internal":
      return error.message;
  }
}

async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  try {
    return options === undefined
      ? await tauriInvoke<T>(command, args)
      : await tauriInvoke<T>(command, args, options);
  } catch (error) {
    if (isCommandError(error)) {
      throw Object.assign(new Error(commandErrorMessage(error)), { cause: error });
    }
    throw error;
  }
}

// Vault
export const selectVault = (path: string) =>
  invoke<VaultOpenResult>("select_vault", { path });

export const openVault = (path: string) =>
  invoke<VaultOpenResult>("open_vault", { path });

export const getVaultPath = () =>
  invoke<string | null>("get_vault_path");

export const reportNativeShellSmoke = (report: NativeShellSmokeReport) =>
  invoke<void>("report_native_shell_smoke", { report });

export const listKnownVaults = () =>
  invoke<string[]>("list_known_vaults");

/** Every known space with whether it can be opened now (SPEC_VAULT_LIFECYCLE.md, П25). */
export const listSpaces = () =>
  invoke<SpaceEntry[]>("list_spaces");

export const startVaultSync = () =>
  invoke<boolean>("start_vault_sync");

export type StartupMilestone =
  | "frontend_entry"
  | "window_shell_painted"
  | "first_route_committed"
  | "first_cards_painted"
  | "space_switch_requested"
  | "tag_reorder_dropped"
  | "tag_reorder_written"
  | "tag_reorder_reloaded"
  | "tag_reorder_painted"
  | "update_ready"
  | "interactive";

export const recordStartupMilestone = (event: StartupMilestone) =>
  invoke<void>("record_startup_milestone", { event });

export const startStartupMaintenance = () =>
  invoke<boolean>("start_startup_maintenance");

export const getVaultStats = (current_collection?: string | null) =>
  invoke<VaultStats>("get_vault_stats", {
    current_collection: current_collection ?? null,
  });

export const getArticleAudioState = (slug: string) =>
  invoke<ArticleAudioState>("get_article_audio_state", { slug });

export const generateArticleAudio = (slug: string) =>
  invoke<ArticleAudioState>("generate_article_audio", { slug });

export const deleteArticleAudio = (slug: string) =>
  invoke<void>("delete_article_audio", { slug });

export const setArticleAudioPosition = (
  slug: string,
  position_ms: number,
  duration_ms: number | null,
  completed: boolean,
) =>
  invoke<void>("set_article_audio_position", {
    slug,
    position_ms,
    duration_ms,
    completed,
  });

// Blocks
export const getGridRows = (path: string, slugs: string[]) =>
  invoke<import("@/types").GridRowsSnapshot>("get_grid_rows", { path, slugs });

export const listBlocks = () =>
  invoke<LightBlock[]>("list_blocks");

export const listGridBlocks = (
  current_tag?: string,
  offset?: number,
  limit?: number,
  order?: FeedOrder,
) =>
  invoke<GridSnapshot>("list_grid_blocks", {
    current_tag: current_tag ?? null,
    offset: offset ?? null,
    limit: limit ?? null,
    order: order ?? null,
  });

export const searchGridBlocks = (
  current_tag: string | undefined,
  query: string,
  limit: number,
  cursor?: SearchPageToken,
) =>
  invoke<SearchSnapshot>("search_grid_blocks", {
    current_tag: current_tag ?? null,
    query,
    limit,
    cursor: cursor ?? null,
  });

export const listGraphSnapshot = (scope: GraphScope, options: GraphOptions) =>
  invoke<GraphSnapshot>("list_graph_snapshot", {
    scope,
    options,
  });

export const getBlock = (slug: string) =>
  invoke<IndexedBlock | null>("get_block", { slug });

export const resolveNoteLink = (sourceSlug: string, rawTarget: string) =>
  invoke<string | null>("resolve_note_link", { sourceSlug, rawTarget });

export const createBlock = (params: CreateBlockParams) =>
  invoke<IndexedBlock>("create_block", { params });

export const readClipboardPayload = () =>
  invoke<ClipboardPayload>("read_clipboard_payload");

export const listShortcutOverrides = () =>
  invoke<Record<string, ShortcutBinding>>("list_shortcut_overrides");

export const saveShortcutOverrides = (overrides: Record<string, ShortcutBinding>) =>
  invoke<null>("save_shortcut_overrides", { overrides });

export const setShortcutCaptureActive = (active: boolean) =>
  invoke<null>("set_shortcut_capture_active", { active });

function normalizeInlineMediaExtractError(error: unknown): InlineMediaExtractError {
  if (error && typeof error === "object" && "kind" in error) {
    return error as InlineMediaExtractError;
  }
  if (typeof error === "string") {
    return { kind: "internal", message: error };
  }
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  return { kind: "internal", message: String(error) };
}

export const extractInlineMedia = async (params: ExtractInlineMediaParams) => {
  try {
    return await tauriInvoke<IndexedBlock>("extract_inline_media", { params });
  } catch (error) {
    throw normalizeInlineMediaExtractError(error);
  }
};

function normalizeMediaAssetActionError(error: unknown): MediaAssetActionError {
  if (error && typeof error === "object" && "kind" in error) {
    return error as MediaAssetActionError;
  }
  if (typeof error === "string") {
    return { kind: "internal", message: error };
  }
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  return { kind: "internal", message: String(error) };
}

export const createMediaAssetCard = async (params: CreateMediaAssetCardParams) => {
  try {
    return await tauriInvoke<IndexedBlock>("create_media_asset_card", { params });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const renameMediaAsset = async (params: RenameMediaAssetParams) => {
  try {
    return await tauriInvoke<MediaAssetMutationResult>("rename_media_asset", { params });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const prepareDeleteMediaAsset = async (media_ref: string) => {
  try {
    return await tauriInvoke<DeleteMediaAssetPlan>("prepare_delete_media_asset", { media_ref });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const deleteMediaAsset = async (media_ref: string) => {
  try {
    return await tauriInvoke<MediaAssetMutationResult>("delete_media_asset", { media_ref });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

/** Remove the card's source video: its link, poster property and unshared poster file.
 *  See SPEC_MEDIA_ASSET_ACTIONS.md «Меню видео источника». */
export const deleteSourceVideo = async (slug: string) => {
  try {
    return await tauriInvoke<MediaAssetMutationResult>("delete_source_video", { slug });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const removeMediaAssetFromCard = async (params: RemoveMediaAssetFromCardParams) => {
  try {
    return await tauriInvoke<MediaAssetMutationResult>("remove_media_asset_from_card", { params });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const copyMediaAssetToClipboard = async (media_ref: string) => {
  try {
    await tauriInvoke<void>("copy_media_asset_to_clipboard", { media_ref });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

function normalizeTextSelectionExtractError(error: unknown): TextSelectionExtractError {
  if (error && typeof error === "object" && "kind" in error) {
    return error as TextSelectionExtractError;
  }
  if (typeof error === "string") {
    return { kind: "internal", message: error };
  }
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  return { kind: "internal", message: String(error) };
}

export const extractTextSelection = async (params: ExtractTextSelectionParams) => {
  try {
    return await tauriInvoke<IndexedBlock>("extract_text_selection", { params });
  } catch (error) {
    throw normalizeTextSelectionExtractError(error);
  }
};

export const deleteTextSelection = async (params: DeleteTextSelectionParams) => {
  try {
    return await tauriInvoke<IndexedBlock>("delete_text_selection", { params });
  } catch (error) {
    throw normalizeTextSelectionExtractError(error);
  }
};

function normalizeRenameBlockError(error: unknown): RenameBlockError {
  if (error && typeof error === "object" && "kind" in error) {
    return error as RenameBlockError;
  }
  if (typeof error === "string") {
    return { kind: "internal", message: error };
  }
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  return { kind: "internal", message: String(error) };
}

export const renameBlockFile = async (old_slug: string, new_stem: string) => {
  try {
    return await tauriInvoke<RenameBlockResult>("rename_block_file", { old_slug, new_stem });
  } catch (error) {
    throw normalizeRenameBlockError(error);
  }
};

export const prepareDeleteBlock = (slug: string) =>
  invoke<DeleteBlockPlan>("prepare_delete_block", { slug });

/** Delete the selection atomically, retaining all source media. */
export const deleteBlocks = (slugs: string[]) => invoke<number>("delete_blocks", { slugs });

export const deleteBlock = (slug: string, delete_unused_media?: boolean) =>
  invoke<boolean>(
    "delete_block",
    delete_unused_media === undefined ? { slug } : { slug, delete_unused_media },
  );

function normalizeMergeBlocksError(error: unknown): MergeBlocksError {
  if (error && typeof error === "object" && "kind" in error) {
    return error as MergeBlocksError;
  }
  if (typeof error === "string") {
    return { kind: "internal", message: error };
  }
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  return { kind: "internal", message: String(error) };
}

export const mergeBlocks = async (ordered_slugs: string[]) => {
  try {
    return await tauriInvoke<MergeBlocksResult>("merge_blocks", { ordered_slugs });
  } catch (error) {
    throw normalizeMergeBlocksError(error);
  }
};

// Tags
export const listTags = () =>
  invoke<TagCount[]>("list_tags");

export const addTag = (slug: string, tag: string) =>
  invoke<void>("add_tag", { slug, tag });

export const removeTag = (slug: string, tag: string) =>
  invoke<void>("remove_tag", { slug, tag });

export const renameTag = (old_tag: string, new_tag: string) =>
  invoke<void>("rename_tag", { old_tag, new_tag });

export const renameChannel = (old_tag: string, new_tag: string) =>
  invoke<import("@/types").ChannelDto>("rename_channel", { old_tag, new_tag });

export const deleteTagFromAll = (tag: string) =>
  invoke<void>("delete_tag_from_all", { tag });

// Channels
export const listChannels = () =>
  invoke<ChannelDto[]>("list_channels");

export const listTaxonomySnapshot = () =>
  invoke<TaxonomySnapshot>("list_taxonomy_snapshot");

export const createChannel = (tag: string) =>
  invoke<ChannelDto>("create_channel", { tag });

export const reorderChannels = (items: { tag: string; position: number }[]) =>
  invoke<void>("reorder_channels", { items });

export const deleteChannel = (tag: string) =>
  invoke<boolean>("delete_channel", { tag });

export const listChannelPreviews = (limit: number) =>
  invoke<ChannelPreviewsSnapshot>("list_channel_previews", { limit });

// Are.na import
export const listArenaChannels = (username: string) =>
  invoke<ArenaChannelInfo[]>("list_arena_channels", { username });

export const importArenaChannels = (channels: ImportChannelRequest[]) =>
  invoke<ImportChannelResult[]>("import_arena_channels", { channels });

// Thumbnails (Phase 2 pipeline — see SPEC_THUMBNAILS.md)
export interface TilePosterUpgrade {
  /** Destination derived filename = the tile's previewPath. */
  posterName: string;
  mediaPath: string;
  kind: "image" | "video";
}

export interface ThumbUpgradeRequest {
  slug: string;
  /** Empty when only tile posters are missing (block thumb already a JPEG). */
  mediaPath: string;
  kind: "image" | "video";
  /** Derived gallery tiles requiring the browser decoder. */
  tilePosters: TilePosterUpgrade[];
}

// Binary IPC: the decoded JPEG travels as the raw request body (Uint8Array →
// application/octet-stream), not a JSON number array, so a 40–80 KB thumb no
// longer inflates ~4x into a payload the main thread must build and Rust must
// parse. Metadata rides in percent-encoded headers — encodeURIComponent keeps
// Unicode slugs (Cyrillic, symbols like ⊷) ASCII-safe for HTTP header
// transport; Rust percent-decodes them.
export const saveThumb = (slug: string, bytes: Uint8Array) =>
  invoke<void>("save_thumb", bytes, {
    headers: { "x-slug": encodeURIComponent(slug) },
  });

/** Write a decoded JPEG for one gallery tile. `posterName` is the tile's
 *  previewPath; `slug` owns the card to refresh. */
export const saveTilePoster = (posterName: string, slug: string, bytes: Uint8Array) =>
  invoke<void>("save_tile_poster", bytes, {
    headers: {
      "x-poster-name": encodeURIComponent(posterName),
      "x-slug": encodeURIComponent(slug),
    },
  });

/** Re-verify the thumb cache against current media dependencies.
 *  Fire on window focus / visibility changes so that external edits
 *  (e.g. an iCloud Drive sync from another device, where notify
 *  delivers no Modify event) eventually propagate to the sidebar. */
export const sweepVaultThumbnails = () =>
  invoke<number>("sweep_vault_thumbnails");

export const listPendingThumbUpgrades = () =>
  invoke<ThumbUpgradeRequest[]>("list_pending_thumb_upgrades");

/** Count what a folder holds before it becomes a space, so the app can say what
 *  is about to happen instead of just doing it. See SPEC_ONBOARDING.md О12. */

/** The folder a browser loads once with Load unpacked; Mine keeps its
 *  contents current. See SPEC_ONBOARDING.md О16. */
export const clipperExtensionFolder = () =>
  invoke<string>("clipper_extension_folder");

/** Whether the first-card marker has not been shown in this space yet (О19). */
export const firstCardMarkerPending = () =>
  invoke<boolean>("first_card_marker_pending");

/** The marker was shown or dismissed; it never returns in this space. */
export const completeFirstCardMarker = () =>
  invoke<null>("complete_first_card_marker");

/** Whether this space never had a card, so its feed still owes the
 *  onboarding; the first card ends it for good (О14, О15). */
export const spaceOnboardingPending = () =>
  invoke<boolean>("space_onboarding_pending");

/** Whether the Keep Downloaded recommendation is due for the active space.
 *  See SPEC_CLOUD_STORAGE.md Х16–Х19. */
export const cloudRecommendationState = () =>
  invoke<CloudRecommendationState>("cloud_recommendation_state");

/** Close the recommendation: for this space, or forever everywhere. */
export const dismissCloudRecommendation = (neverShowAgain: boolean) =>
  invoke<null>("dismiss_cloud_recommendation", { neverShowAgain });

/** The system's own download state for a card's media file.
 *  The percent exists only when macOS publishes one — it is never derived.
 *  See SPEC_CLOUD_STORAGE.md Х4, Х9. */
export const icloudDownloadProgress = (mediaRef: string) =>
  invoke<IcloudDownloadProgress>("icloud_download_progress", { mediaRef });

/** Local page that hosts the YouTube player for a card's source URL.
 *  YouTube refuses an embed without a referrer, and the interface origin
 *  sends none. See SPEC_FRONTEND.md «Видеопрезентация источника карточки». */
export const youtubePlayerUrl = (sourceUrl: string) =>
  invoke<string>("youtube_player_url", { sourceUrl });

/** State of a card's Download Media job, as the shell reports it.
 *  See SPEC_MEDIA_ASSET_ACTIONS.md «Download Media». */
export type SourceVideoDownloadState =
  | { state: "preparing" }
  | { state: "downloading"; percent: number }
  | { state: "finishing" }
  | { state: "done" }
  | { state: "failed"; message: string }
  | { state: "cancelled" };

/** Download the card's source video into the space; progress arrives as
 *  `source-video-download` events. */
export const startSourceVideoDownload = (slug: string, sourceUrl: string) =>
  invoke<null>("start_source_video_download", { slug, sourceUrl });

/** Stop a running download; partial files are removed. */
export const cancelSourceVideoDownload = (slug: string) =>
  invoke<null>("cancel_source_video_download", { slug });

/** The last known download state of a card in this session, if any. */
export const sourceVideoDownloadStatus = (slug: string) =>
  invoke<SourceVideoDownloadState | null>("source_video_download_status", { slug });

/** The saved space that could not be opened, if any.
 *  `null` means either no space was ever chosen or the saved one is reachable —
 *  a missing folder must never look like a fresh install.
 *  See SPEC_VAULT_LIFECYCLE.md П12–П13. */
export const getUnavailableVault = () =>
  invoke<UnavailableVault | null>("get_unavailable_vault");

/** Discard the binding to an unavailable space. User action only. */
export const forgetUnavailableVault = () =>
  invoke<void>("forget_unavailable_vault");

/** Folders new cards, media and collections are written into.
 *  Reading is always recursive; this governs writes only.
 *  See SPEC_VAULT_LIFECYCLE.md П1–П4. */
export const getVaultWriteLayout = (vaultId?: string) =>
  invoke<VaultWriteLayoutDto>("get_vault_write_layout", { vaultId: vaultId ?? null });

export const setVaultWriteLayout = (layout: VaultWriteLayoutDto, vaultId?: string) =>
  invoke<VaultWriteLayoutDto>("set_vault_write_layout", { layout, vaultId: vaultId ?? null });

/** Create the standard folders in this space and write into them from now on. */
export const organizeVaultLayout = (vaultId?: string) =>
  invoke<VaultWriteLayoutDto>("organize_vault_layout", { vaultId: vaultId ?? null });

// Vault conflicts (Phase 18.G.4 — see SPEC_IDENTITY_ROBUSTNESS.md)
export interface VaultConflictItem {
  baseSlug: string;
  conflictSlug: string;
  detectedAt: string;
}

export type VaultConflictResolveAction =
  | "keep_original"
  | "keep_conflict"
  | "dismiss_for_manual_merge";

export const listVaultConflicts = () =>
  invoke<VaultConflictItem[]>("list_vault_conflicts");

export const resolveVaultConflict = (
  baseSlug: string,
  conflictSlug: string,
  action: VaultConflictResolveAction,
) =>
  invoke<void>("resolve_vault_conflict", {
    base_slug: baseSlug,
    conflict_slug: conflictSlug,
    action: { action },
  });

// Clipper recovery
// Settings window
export const openSettingsWindow = (section?: string) =>
  invoke<void>("open_settings_window", { section: section ?? null });

export const setSidebarMenuCollapsed = (collapsed: boolean) =>
  invoke<void>("set_sidebar_menu_collapsed", { collapsed });

export const addKnownVault = (path: string) =>
  invoke<string[]>("add_known_vault", { path });

export const forgetKnownVault = (path: string) =>
  invoke<string[]>("forget_known_vault", { path });

/** Orphan media of the space `vaultId`, else of the tab used last
 *  (SPEC_TABS.md, В71). */
export const listOrphanMedia = (vaultId?: string) =>
  invoke<OrphanMediaList>("list_orphan_media", { vaultId: vaultId ?? null });

// Orphan operations name the space their list was built for; the backend
// refuses them once another space is open.
export const promoteOrphanMedia = (vaultId: string, fileNames: string[]) =>
  invoke<PromoteOrphanResult>("promote_orphan_media", {
    request: { vault_id: vaultId, file_names: fileNames } satisfies OrphanMediaBatchRequest,
  });

export const deleteOrphanMedia = (vaultId: string, fileNames: string[]) =>
  invoke<DeleteOrphanResult>("delete_orphan_media", {
    request: { vault_id: vaultId, file_names: fileNames } satisfies OrphanMediaBatchRequest,
  });

export const spaceStats = (path: string) =>
  invoke<SpaceStats>("space_stats", { path });

export const reorderKnownVaults = (paths: string[]) =>
  invoke<string[]>("reorder_known_vaults", { paths });

export const getUpdateStatus = () => invoke<UpdateStatus>("get_update_status");
export const checkForUpdates = () => invoke<UpdateStatus>("check_for_updates");
export const downloadUpdate = () => invoke<UpdateStatus>("download_update");
export const installUpdate = () => invoke<UpdateStatus>("install_update");
export const restorePreviousUpdate = () => invoke<UpdateStatus>("restore_previous_update");

// ─── Tabs and windows (SPEC_TABS.md, «Команды») ────────────────────────────
// A tab page and a tab bar know themselves by their page label; the backend
// reads it from the calling page, so these take no tab of their own.

/** What this tab page needs to start: its tab, space, memory, sidebar, lead role. */
export const getTabBootstrap = () => invoke<TabBootstrap | null>("get_tab_bootstrap");

/** What this tab bar shows now; later changes arrive as `tabbar-state`. */
export const getTabbarBootstrap = () => invoke<TabBarState | null>("get_tabbar_bootstrap");

/** This tab's memory, sent at most every 250 ms (В31). */
export const reportTabView = (view: TabView) => invoke<void>("report_tab_view", { view });

/** This tab drew its first frame since it was shown (В5). */
export const tabPainted = () => invoke<void>("tab_painted");

/** Show the tab `tabId` in its window. */
export const activateTab = (tabId: TabId) => invoke<void>("activate_tab", { tabId });

/** Show the next (`forward`) or previous tab of this page's window, round the end (В55). */
export const activateAdjacentTab = (forward: boolean) =>
  invoke<void>("activate_adjacent_tab", { forward });

/** Open a new tab in this page's window: the space `vaultId`, else the visible tab's space (В51). */
export const newTab = (vaultId?: string) => invoke<void>("new_tab", { vaultId: vaultId ?? null });

/** Close the tab `tabId` (В53). */
export const closeTab = (tabId: TabId) => invoke<void>("close_tab", { tabId });

/** Close every tab of `tabId`'s window but it (В50). */
export const closeOtherTabs = (tabId: TabId) => invoke<void>("close_other_tabs", { tabId });

/** Move the tab `tabId` to `index` in its window (В60). */
export const moveTab = (tabId: TabId, index: number) => invoke<void>("move_tab", { tabId, index });

/** Move the tab `tabId` into a window of its own (В50, В65). */
export const moveTabToNewWindow = (tabId: TabId) =>
  invoke<void>("move_tab_to_new_window", { tabId });

/** The pointer pulled the tab `tabId` off the bar: the backend follows the
 *  pointer until release, then leaves a new window or joins another window's
 *  bar (В61 по В65). `grabX`/`grabY` are where the tab was grabbed, in
 *  this bar's coordinates. */
export const beginTabDrag = (tabId: TabId, grabX: number, grabY: number) =>
  invoke<void>("begin_tab_drag", { tabId, grabX, grabY });

/** Store and spread the sidebar of this page's window (В56). */
export const setWindowSidebar = (sidebar: SidebarLayout) =>
  invoke<void>("set_window_sidebar", { sidebar });

/** Start dragging this page's window by its chrome (В23). */
export const startWindowDrag = () => invoke<void>("start_window_drag");

/** The chrome colour `#rrggbb` computed from CSS, painted behind every page (В25). */
export const reportWindowSurface = (color: string) =>
  invoke<void>("report_window_surface", { color });

/** Show the space at `path`: its tab used last, or a new tab in the last window (В69, В72). */
export const showSpace = (path: string, goEverything: boolean) =>
  invoke<void>("show_space", { path, goEverything });

/** The identities of every space some tab shows (В69). */
export const spacesInTabs = () => invoke<string[]>("spaces_in_tabs");

/** A notice of this tab's space was closed in this opening (В20). */
export const dismissSpaceNotice = (notice: string) =>
  invoke<void>("dismiss_space_notice", { notice });

/** Whether a notice of this tab's space was closed in this opening (В20). */
export const spaceNoticeDismissed = (notice: string) =>
  invoke<boolean>("space_notice_dismissed", { notice });

/** This tab bar reports the slot under a dragged tab from another window,
 *  or `null` when none (В63). Sent while `tabbar-drop-hover` arrives. */
export const reportDropSlot = (index: number | null) =>
  invoke<void>("report_drop_slot", { index });
