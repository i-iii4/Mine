// Tauri IPC wrappers. Thin typed layer over invoke().
// Each function maps 1:1 to a #[tauri::command] in Rust.

import {
  invoke as tauriInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";
import type {
  IndexedBlock,
  GridSnapshot,
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
  ClipperSetupStatus,
  FolderPreview,
  CreateBlockParams,
  ArenaChannelInfo,
  ImportChannelRequest,
  ImportChannelResult,
  ArticleAudioState,
  ClipperRecoveryItem,
  RecoveredClipperBlock,
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
  OrphanMedia,
  OrphanMediaBatchRequest,
  PromoteOrphanResult,
  DeleteOrphanResult,
  SpaceStats,
  NativeShellSmokeReport,
  CommandError,
  IcloudDownloadProgress,
  CloudRecommendationState,
} from "@/types";

function isCommandError(error: unknown): error is CommandError {
  if (!error || typeof error !== "object" || !("kind" in error)) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === "no_vault" || kind === "internal";
}

function commandErrorMessage(error: CommandError): string {
  return error.kind === "no_vault" ? "no vault selected" : error.message;
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

export const startVaultSync = () =>
  invoke<boolean>("start_vault_sync");

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
export const listBlocks = () =>
  invoke<LightBlock[]>("list_blocks");

export const listGridBlocks = (
  current_tag?: string,
  offset?: number,
  limit?: number,
) =>
  invoke<GridSnapshot>("list_grid_blocks", {
    current_tag: current_tag ?? null,
    offset: offset ?? null,
    limit: limit ?? null,
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

export const createBlock = (params: CreateBlockParams) =>
  invoke<IndexedBlock>("create_block", { params });

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
export const previewVaultFolder = (path: string) =>
  invoke<FolderPreview>("preview_vault_folder", { path });

/** What the clipper setup looks like right now: helper version and which
 *  browsers are registered. See SPEC_ONBOARDING.md О7. */
export const getClipperSetupStatus = () =>
  invoke<ClipperSetupStatus>("get_clipper_setup_status");

/** Install the helper and register it with every browser found. */
export const installClipperHost = (extensionId: string) =>
  invoke<ClipperSetupStatus>("install_clipper_host", { extensionId });

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
export const getVaultWriteLayout = () =>
  invoke<VaultWriteLayoutDto>("get_vault_write_layout");

export const setVaultWriteLayout = (layout: VaultWriteLayoutDto) =>
  invoke<VaultWriteLayoutDto>("set_vault_write_layout", { layout });

/** Create the standard folders in this space and write into them from now on. */
export const organizeVaultLayout = () =>
  invoke<VaultWriteLayoutDto>("organize_vault_layout");

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
export const listClipperRecoveryItems = () =>
  invoke<ClipperRecoveryItem[]>("list_clipper_recovery_items");

export const recoverClipperPendingUpload = (upload_id: string) =>
  invoke<RecoveredClipperBlock>("recover_clipper_pending_upload", { upload_id });

export const discardClipperPendingUpload = (upload_id: string) =>
  invoke<void>("discard_clipper_pending_upload", { upload_id });

// Settings window
export const openSettingsWindow = () =>
  invoke<void>("open_settings_window");

export const setSidebarMenuCollapsed = (collapsed: boolean) =>
  invoke<void>("set_sidebar_menu_collapsed", { collapsed });

export const addKnownVault = (path: string) =>
  invoke<string[]>("add_known_vault", { path });

export const forgetKnownVault = (path: string) =>
  invoke<string[]>("forget_known_vault", { path });

export const listOrphanMedia = () =>
  invoke<OrphanMedia[]>("list_orphan_media");

export const promoteOrphanMedia = (fileNames: string[]) =>
  invoke<PromoteOrphanResult>("promote_orphan_media", {
    request: { file_names: fileNames } satisfies OrphanMediaBatchRequest,
  });

export const deleteOrphanMedia = (fileNames: string[]) =>
  invoke<DeleteOrphanResult>("delete_orphan_media", {
    request: { file_names: fileNames } satisfies OrphanMediaBatchRequest,
  });

export const spaceStats = (path: string) =>
  invoke<SpaceStats>("space_stats", { path });

export const reorderKnownVaults = (paths: string[]) =>
  invoke<string[]>("reorder_known_vaults", { paths });
