// TypeScript types matching Rust Serialize output.
// Manually maintained until specta type generation is set up (Phase 7).

export type BlockType = "image" | "article" | "link" | "video" | "file" | "channel";
export type CardKind = "article" | "media" | "channel";
export type ThumbFormat = "jpeg" | "png";

export interface IndexedBlock {
  id: number;
  slug: string;
  card_kind: CardKind;
  block_type: BlockType;
  title: string | null;
  content_heading?: string | null;
  display_title?: string | null;
  fallback_label?: string | null;
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
  preview_text?: string | null;
  first_image: string | null;
  media_urls: string | null;
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
  thumb_format: ThumbFormat | null;
  thumb_mtime: number;
  related_notes: string[];
  body_hash: string | null;
  origin?: string | null;
  index_warning?: string | null;
  tags: string[];
}

export type SearchMatchField = "title" | "description" | "author" | "body" | "url" | "semantic";
export type SearchMatchKind = "exact" | "prefix" | "fuzzy" | "alias" | "semantic";

export interface SearchTextRange {
  start: number;
  end: number;
}

export interface SearchMatch {
  field: SearchMatchField;
  kind: SearchMatchKind;
  excerpt: string;
  ranges: SearchTextRange[];
  score: number;
  explanation?: string | null;
}

/** Lightweight block for grid/list views (short body preview, no tag array). */
export interface LightBlock {
  id: number;
  slug: string;
  card_kind: CardKind;
  block_type: BlockType;
  title: string | null;
  content_heading?: string | null;
  display_title?: string | null;
  fallback_label?: string | null;
  url: string | null;
  media_file: string | null;
  thumbnail: string | null;
  saved_at: string;
  width: number | null;
  height: number | null;
  author: string | null;
  body: string;
  /** Clean, word-boundary-truncated feed preview prepared by the indexer. */
  preview_text?: string | null;
  first_image: string | null;
  media_urls: string | null;
  media_dimensions: string | null;
  preview_manifest: string | null;
  feed_playback: string | null;
  search_match?: SearchMatch | null;
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

export interface DeleteBlockMedia {
  path: string;
  file_name: string;
  kind: "image" | "video" | "audio" | "document" | "file";
  referenced_by: string[];
}

export interface DeleteBlockPlan {
  slug: string;
  markdown_file: string;
  unused_media: DeleteBlockMedia[];
  shared_media: DeleteBlockMedia[];
}

export interface MergeBlocksResult {
  block: IndexedBlock;
  merged_slug: string;
  removed_slugs: string[];
}

export type MergeBlocksError =
  | { kind: "no_vault" }
  | { kind: "too_few_cards" }
  | { kind: "duplicate_slug"; slug: string }
  | { kind: "block_not_found"; slug: string }
  | { kind: "block_not_mergeable"; slug: string; block_type: string }
  | { kind: "invalid_slug"; slug: string; reason: string }
  | { kind: "reference_rewrite_failed"; path: string; message: string }
  | { kind: "internal"; message: string };

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
}

export type MediaAssetKind = "image" | "video" | "file";

export interface MediaAssetRef {
  media_ref: string;
  media_kind: MediaAssetKind;
  source_slug: string;
  reference_kind: "frontmatter_file" | "body_embed";
  // 0-based index of this embed among identical body refs to the same file.
  // Lets removal target a single duplicate; null/undefined removes every match.
  occurrence_index?: number | null;
}

export interface CreateMediaAssetCardParams {
  media_ref: string;
  target_tag: string;
  source_slug?: string | null;
}

export interface RemoveMediaAssetFromCardParams {
  media_ref: string;
  source_slug: string;
  reference_kind: MediaAssetRef["reference_kind"];
  occurrence_index?: number | null;
}

export interface RenameMediaAssetParams {
  media_ref: string;
  new_stem: string;
}

export interface MediaAssetMutationResult {
  media_ref: string;
  new_media_ref: string | null;
  affected_slugs: string[];
}

export type DeleteMediaAssetKind = "image" | "video" | "audio" | "document" | "file";

export interface MediaAssetReferenceBlock {
  slug: string;
  title: string | null;
  display_title: string | null;
  fallback_label: string;
  card_kind: CardKind;
  reference_kinds: string[];
}

export interface DeleteMediaAssetPlan {
  media_ref: string;
  media_kind: DeleteMediaAssetKind;
  referenced_by: MediaAssetReferenceBlock[];
}

export type MediaAssetActionError =
  | { kind: "no_vault" }
  | { kind: "invalid_media_ref"; reason: string }
  | { kind: "media_not_found"; media_ref: string }
  | { kind: "unsupported_media_kind"; media_ref: string }
  | { kind: "name_taken"; target: string }
  | { kind: "invalid_filename"; reason: string }
  | { kind: "clipboard_unsupported"; media_ref: string }
  | { kind: "internal"; message: string };

export type InlineMediaExtractError =
  | { kind: "no_vault" }
  | { kind: "source_not_found"; source_slug: string }
  | { kind: "source_not_article"; source_slug: string; block_type: string }
  | { kind: "invalid_media_ref"; reason: string }
  | { kind: "media_not_referenced"; media_ref: string; source_slug: string }
  | { kind: "media_not_found"; media_ref: string }
  | { kind: "unsupported_media_type"; media_ref: string }
  | { kind: "internal"; message: string };

export interface ExtractTextSelectionParams {
  source_slug: string;
  target_tag: string;
  selected_text: string;
  first_block_start: number;
  first_block_end: number;
  source_body_hash: string;
}

export interface DeleteTextSelectionParams {
  source_slug: string;
  selected_text: string;
  first_block_start: number;
  first_block_end: number;
  source_body_hash: string;
}

export type TextSelectionExtractError =
  | { kind: "no_vault" }
  | { kind: "source_not_found"; source_slug: string }
  | { kind: "source_not_article"; source_slug: string; block_type: string }
  | { kind: "empty_selection" }
  | { kind: "stale_selection" }
  | { kind: "unsupported_selection_shape"; reason: string }
  | { kind: "unsafe_source_patch"; reason: string }
  | { kind: "invalid_collection_ref"; reason: string }
  | { kind: "internal"; message: string };

export interface TagCount {
  tag: string;
  count: number;
}

export interface ChannelDto {
  tag: string;
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

export interface VaultStats {
  totalFileCount: number;
  markdownFileCount: number;
  mediaFileCount: number;
  sourceBytes: number;
  currentCollectionCardCount: number;
  currentCollection: string | null;
  updatedAtMs: number;
}

// ─── Channel preview (sidebar icons) ────────────────────────────────────────

export interface PreviewItem {
  slug: string;
  text: boolean;
  mtime: number;
  has_thumb: boolean;
}

export interface PreviewCard {
  slug?: string;
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

export type ClipperRecoveryKind = "pending_upload";

export interface ClipperRecoveryItem {
  id: string;
  kind: ClipperRecoveryKind;
  fileName: string;
  mediaPath: string | null;
  size: number;
  createdAt: string;
}

export interface RecoveredClipperBlock {
  slug: string;
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

// ─── Settings window ─────────────────────────────────────────────────────────

export interface OrphanMedia {
  file_name: string;
  size_bytes: number;
  modified_secs: number;
}

export interface PromoteOrphanResult {
  created: IndexedBlock[];
  skipped: string[];
}

export interface DeleteOrphanResult {
  deleted: string[];
  skipped: string[];
}

export interface SpaceStats {
  file_count: number;
  markdown_count: number;
  media_count: number;
  total_bytes: number;
  element_count: number | null;
}
