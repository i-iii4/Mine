// Tauri IPC wrappers. Thin typed layer over invoke().
// Each function maps 1:1 to a #[tauri::command] in Rust.

import { invoke } from "@tauri-apps/api/core";
import type {
  IndexedBlock,
  GridSnapshot,
  LightBlock,
  DeleteBlockPlan,
  RenameBlockError,
  RenameBlockResult,
  TagCount,
  ChannelDto,
  TaxonomySnapshot,
  VaultStats,
  VaultOpenResult,
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
} from "@/types";

// Vault
export const selectVault = (path: string) =>
  invoke<VaultOpenResult>("select_vault", { path });

export const openVault = (path: string) =>
  invoke<VaultOpenResult>("open_vault", { path });

export const getVaultPath = () =>
  invoke<string | null>("get_vault_path");

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
  query?: string,
) =>
  invoke<GridSnapshot>("list_grid_blocks", {
    current_tag: current_tag ?? null,
    offset: offset ?? null,
    limit: limit ?? null,
    query: query ?? null,
  });

export const getBlock = (slug: string) =>
  invoke<IndexedBlock | null>("get_block", { slug });

export const createBlock = (params: CreateBlockParams) =>
  invoke<IndexedBlock>("create_block", { ...params });

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
    return await invoke<IndexedBlock>("extract_inline_media", { ...params });
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
    return await invoke<IndexedBlock>("create_media_asset_card", { ...params });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const renameMediaAsset = async (params: RenameMediaAssetParams) => {
  try {
    return await invoke<MediaAssetMutationResult>("rename_media_asset", { ...params });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const prepareDeleteMediaAsset = async (media_ref: string) => {
  try {
    return await invoke<DeleteMediaAssetPlan>("prepare_delete_media_asset", { media_ref });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const deleteMediaAsset = async (media_ref: string) => {
  try {
    return await invoke<MediaAssetMutationResult>("delete_media_asset", { media_ref });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const removeMediaAssetFromCard = async (params: RemoveMediaAssetFromCardParams) => {
  try {
    return await invoke<MediaAssetMutationResult>("remove_media_asset_from_card", { ...params });
  } catch (error) {
    throw normalizeMediaAssetActionError(error);
  }
};

export const copyMediaAssetToClipboard = async (media_ref: string) => {
  try {
    await invoke<void>("copy_media_asset_to_clipboard", { media_ref });
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
    return await invoke<IndexedBlock>("extract_text_selection", { ...params });
  } catch (error) {
    throw normalizeTextSelectionExtractError(error);
  }
};

export const deleteTextSelection = async (params: DeleteTextSelectionParams) => {
  try {
    return await invoke<IndexedBlock>("delete_text_selection", { ...params });
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
    return await invoke<RenameBlockResult>("rename_block_file", { old_slug, new_stem });
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
    return await invoke<MergeBlocksResult>("merge_blocks", { ordered_slugs });
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
  invoke<Record<string, import("@/types").PreviewItem[]>>("list_channel_previews", { limit });

// Are.na import
export const listArenaChannels = (username: string) =>
  invoke<ArenaChannelInfo[]>("list_arena_channels", { username });

export const importArenaChannels = (channels: ImportChannelRequest[]) =>
  invoke<ImportChannelResult[]>("import_arena_channels", { channels });

// Thumbnails (Phase 2 pipeline — see SPEC_THUMBNAILS.md)
export interface ThumbUpgradeRequest {
  slug: string;
  mediaPath: string;
  kind: "image" | "video";
}

export const saveThumb = (slug: string, bytes: Uint8Array) =>
  invoke<void>("save_thumb", { slug, bytes: Array.from(bytes) });

/** Re-verify the thumb cache against current media dependencies.
 *  Fire on window focus / visibility changes so that external edits
 *  (e.g. an iCloud Drive sync from another device, where notify
 *  delivers no Modify event) eventually propagate to the sidebar. */
export const sweepVaultThumbnails = () =>
  invoke<number>("sweep_vault_thumbnails");

export const listPendingThumbUpgrades = () =>
  invoke<ThumbUpgradeRequest[]>("list_pending_thumb_upgrades");

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
