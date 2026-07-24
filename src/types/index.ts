export type * from "./generated";

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


// ─── Channel preview (sidebar icons) ────────────────────────────────────────

export interface PreviewCard {
  slug?: string;
  url: string;
  text: boolean;
  hasThumb: boolean;
}

// ─── Are.na import ──────────────────────────────────────────────────────────

// ─── Settings window ─────────────────────────────────────────────────────────
