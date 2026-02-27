// TypeScript types matching Rust Serialize output.
// Manually maintained until specta type generation is set up (Phase 7).

export type BlockType = "image" | "article" | "link" | "video" | "file";

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
  tags: string[];
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

export interface ScanResult {
  indexed: number;
  errors: number;
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
