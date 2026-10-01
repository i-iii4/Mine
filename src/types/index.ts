export type * from "./generated";

export type MediaAssetKind = "image" | "video" | "file";

export interface MediaAssetRef {
  media_ref: string;
  media_kind: MediaAssetKind;
  source_slug: string;
  reference_kind: "frontmatter_file" | "body_embed";
  // The clicked image of a body embed: how many `![` precede its own `![` in
  // the card's body (SPEC_AUDIT_FIXES.md, Г1.4). null/undefined removes every
  // image of the media.
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
