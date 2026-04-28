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
  preview_manifest: string | null;
  feed_playback: string | null;
  related_notes: string[];
  origin?: string | null;
  index_warning?: string | null;
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
  preview_manifest: string | null;
  feed_playback: string | null;
}

export type FeedPreviewKind = "text" | "image" | "video_poster" | "composite";

export interface FeedPreviewTile {
  source_path?: string | null;
  preview_path?: string | null;
  src?: string | null;
  width: number | null;
  height: number | null;
  is_video: boolean;
  is_video_poster: boolean;
}

export interface FeedPreviewManifest {
  kind: FeedPreviewKind;
  primary_preview_path: string | null;
  width: number | null;
  height: number | null;
  tiles: FeedPreviewTile[];
  overflow_count: number;
}

export type FeedPlaybackKind = "single_video";
export type FeedPlaybackContainer = "mp4" | "webm";
export type FeedPlaybackProfile = "standard" | "heavy";

export type ArticleAudioStatus = "absent" | "ready";

export interface ArticleAudioState {
  status: ArticleAudioStatus;
  audio_path: string | null;
  duration_ms: number | null;
  last_position_ms: number;
  completed_at: string | null;
}

export interface FeedPlaybackDescriptor {
  kind: FeedPlaybackKind;
  source_path: string;
  poster_preview_path: string;
  width: number | null;
  height: number | null;
  container: FeedPlaybackContainer;
  profile: FeedPlaybackProfile;
}

export interface GridSnapshot {
  blocks: LightBlock[];
  total_blocks: number;
  has_more: boolean;
}

export interface RenameBlockResult {
  old_slug: string;
  new_slug: string;
}

export type RenameBlockError =
  | { kind: "no_vault" }
  | { kind: "block_not_found"; slug: string }
  | { kind: "invalid_filename"; reason: string }
  | { kind: "name_taken"; requested: string }
  | { kind: "internal"; message: string };

export interface ExtractInlineMediaParams {
  source_slug: string;
  media_ref: string;
  target_tag: string;
  title?: string | null;
}

export type InlineMediaExtractError =
  | { kind: "no_vault" }
  | { kind: "source_not_found"; source_slug: string }
  | { kind: "source_not_article"; source_slug: string; block_type: string }
  | { kind: "invalid_media_ref"; reason: string }
  | { kind: "media_not_referenced"; media_ref: string; source_slug: string }
  | { kind: "media_not_found"; media_ref: string }
  | { kind: "unsupported_media_type"; media_ref: string }
  | { kind: "internal"; message: string };

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

export interface TaxonomySnapshot {
  tags: TagCount[];
  channels: ChannelDto[];
  total_blocks: number;
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
  derived_store_ready: boolean;
  bootstrapped_from_legacy: boolean;
  migration_required: boolean;
  thumbs_root: string;
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
