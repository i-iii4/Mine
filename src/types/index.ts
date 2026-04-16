// TypeScript types matching Rust Serialize output.
// Manually maintained until specta type generation is set up (Phase 7).

export type BlockType = "image" | "article" | "link" | "video" | "file" | "channel";

export interface IndexedBlock {
  id: number;
  slug: string;
  block_type: BlockType;
  title: string | null;
  description: string | null;
  url: string | null;
  media_file: string | null;
  thumbnail: string | null;
  saved_at: string;
  source: string | null;
  width: number | null;
  height: number | null;
  author: string | null;
  body: string;
  /**
   * Per-image pixel dimensions as a JSON string. Populated by the Rust
   * indexer at index time: keys are media filenames referenced by the
   * block, values are `[width, height]` arrays. Null for blocks indexed
   * before the `media_dimensions` column existed — the frontend falls
   * back to a fixed aspect ratio in that case.
   */
  media_dimensions: string | null;
  tags: string[];
}

/** Lightweight block for grid/list views (short body preview, no tag array). */
export interface LightBlock {
  id: number;
  slug: string;
  block_type: BlockType;
  title: string | null;
  url: string | null;
  media_file: string | null;
  thumbnail: string | null;
  saved_at: string;
  width: number | null;
  height: number | null;
  author: string | null;
  body: string;
  first_image: string | null;
  media_urls: string | null;
  media_dimensions: string | null;
}

export interface GridSnapshot {
  blocks: LightBlock[];
  total_blocks: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface ChannelDto {
  tag: string;
  title: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  position: number;
  created_at: string;
  block_count: number;
}

// ─── Channel preview (sidebar icons) ────────────────────────────────────────

export interface PreviewItem {
  slug: string;
  text: boolean;
  mtime: number;
  has_thumb: boolean;
}

export interface PreviewCard {
  url: string;
  text: boolean;
  hasThumb: boolean;
}

export interface ScanResult {
  indexed: number;
  errors: number;
}

export interface VaultOpenResult {
  indexed: number;
  errors: number;
  sync_in_progress: boolean;
}

export interface CreateBlockParams {
  block_type: string;
  title?: string;
  url?: string;
  tags: string[];
  file_path?: string;
}

// ─── Are.na import ──────────────────────────────────────────────────────────

export interface ArenaChannelInfo {
  id: number;
  title: string;
  slug: string;
  length: number;
  status: string;
}

export interface ImportChannelRequest {
  slug: string;
  tag: string;
}

export interface ImportChannelResult {
  channel_slug: string;
  channel_title: string;
  imported: number;
  skipped: number;
  errors: string[];
}

export interface ImportProgress {
  channel_slug: string;
  current: number;
  total: number;
  block_title: string | null;
}
