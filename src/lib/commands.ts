// Tauri IPC wrappers. Thin typed layer over invoke().
// Each function maps 1:1 to a #[tauri::command] in Rust.

import { invoke } from "@tauri-apps/api/core";
import type {
  IndexedBlock,
  GridSnapshot,
  LightBlock,
  TagCount,
  ChannelDto,
  TaxonomySnapshot,
  VaultOpenResult,
  CreateBlockParams,
  ArenaChannelInfo,
  ImportChannelRequest,
  ImportChannelResult,
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

// Blocks
export const listBlocks = () =>
  invoke<LightBlock[]>("list_blocks");

export const listGridBlocks = (current_tag?: string, offset?: number, limit?: number) =>
  invoke<GridSnapshot>("list_grid_blocks", {
    current_tag: current_tag ?? null,
    offset: offset ?? null,
    limit: limit ?? null,
  });

export const getBlock = (slug: string) =>
  invoke<IndexedBlock | null>("get_block", { slug });

export const createBlock = (params: CreateBlockParams) =>
  invoke<IndexedBlock>("create_block", { ...params });

export const deleteBlock = (slug: string) =>
  invoke<boolean>("delete_block", { slug });

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

// Search
export const search = (query: string) =>
  invoke<IndexedBlock[]>("search", { query });

// Channels
export const listChannels = () =>
  invoke<ChannelDto[]>("list_channels");

export const listTaxonomySnapshot = () =>
  invoke<TaxonomySnapshot>("list_taxonomy_snapshot");

export const createChannel = (tag: string, title?: string) =>
  invoke<ChannelDto>("create_channel", { tag, title });

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

export const listPendingThumbUpgrades = () =>
  invoke<ThumbUpgradeRequest[]>("list_pending_thumb_upgrades");
