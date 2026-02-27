// Tauri IPC wrappers. Thin typed layer over invoke().
// Each function maps 1:1 to a #[tauri::command] in Rust.

import { invoke } from "@tauri-apps/api/core";
import type {
  IndexedBlock,
  TagCount,
  ChannelDto,
  ScanResult,
  CreateBlockParams,
  ArenaChannelInfo,
  ImportChannelRequest,
  ImportChannelResult,
} from "@/types";

// Vault
export const selectVault = (path: string) =>
  invoke<ScanResult>("select_vault", { path });

export const getVaultPath = () =>
  invoke<string | null>("get_vault_path");

export const rebuildIndex = () =>
  invoke<ScanResult>("rebuild_index");

// Blocks
export const listBlocks = () =>
  invoke<IndexedBlock[]>("list_blocks");

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

// Search
export const search = (query: string) =>
  invoke<IndexedBlock[]>("search", { query });

// Channels
export const listChannels = () =>
  invoke<ChannelDto[]>("list_channels");

export const createChannel = (tag: string, title?: string) =>
  invoke<ChannelDto>("create_channel", { tag, title });

export const reorderChannels = (items: { tag: string; position: number }[]) =>
  invoke<void>("reorder_channels", { items });

export const deleteChannel = (tag: string) =>
  invoke<boolean>("delete_channel", { tag });

// Are.na import
export const listArenaChannels = (username: string) =>
  invoke<ArenaChannelInfo[]>("list_arena_channels", { username });

export const importArenaChannels = (channels: ImportChannelRequest[]) =>
  invoke<ImportChannelResult[]>("import_arena_channels", { channels });
