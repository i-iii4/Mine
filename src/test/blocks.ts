import type { BlockType, CardKind, IndexedBlock, LightBlock } from "@/types";

// Complete block rows for tests. Every field the backend sends is present
// (src/types/generated.ts), so a test that builds a block states only what it
// checks and still hands components the shape they receive at runtime. The
// neutral values match a card with no heading, no media and nothing measured;
// the fallback label is the slug, which is what the card shows for a block
// without one. The kind follows the type unless the test names it, so an
// image block is never silently an article card.

/** The card kind of a block of this type when nothing else decides it. */
export function cardKindForBlockType(blockType: BlockType): CardKind {
  switch (blockType) {
    case "article":
      return "article";
    case "link":
      return "link";
    case "channel":
      return "channel";
    case "image":
    case "video":
    case "file":
      return "media";
  }
}

export function lightBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  const slug = overrides.slug ?? "block";
  const blockType = overrides.block_type ?? "article";
  return {
    id: 1,
    slug,
    block_type: blockType,
    card_kind: cardKindForBlockType(blockType),
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: slug,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    collections: [],
    search_match: null,
    ...overrides,
  };
}

export function indexedBlock(overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  const slug = overrides.slug ?? "block";
  const blockType = overrides.block_type ?? "article";
  return {
    id: 1,
    slug,
    block_type: blockType,
    card_kind: cardKindForBlockType(blockType),
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: slug,
    description: null,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    origin: null,
    index_warning: null,
    tags: [],
    ...overrides,
  };
}
