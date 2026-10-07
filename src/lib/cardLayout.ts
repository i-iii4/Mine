import type { LightBlock } from "@/types";
import {
  normalizeFeedPreviewManifest,
  type NormalizedFeedPreviewTile,
} from "@/lib/feedPreview";
import { getDisplayTitle, getMediaOwnTitle } from "@/lib/displayTitle";
import type { FeedShow } from "@/lib/feedDisplay";
import { clampCardAspect } from "@/lib/cardAspect";
import { parseYoutubeSource } from "@/lib/youtubeSource";
import { shownCollections } from "@/lib/cardCollections";

// One card (SPEC_CARD_UNIFIED.md). What a card shows is decided by its content
// alone: its media and its text (Е3). The kind of record the content comes
// from decides only how each part is read from the record's data (a picture's
// title is only a real heading, an X post has none); the card's look never
// reads it (Е1).

/// The kind of record a card's content is read from (Е3). The feed card does
/// not look at it; the open card (Detail) does, to play a video or show a
/// link's page.
export type CardSourceKind = "image" | "video" | "file" | "link" | "article" | "social" | "channel";

export interface CardLayoutMediaItem {
  sourcePath: string;
  previewPath: string | null;
  aspectRatio: number | null;
  isVideo: boolean;
  isVideoPoster: boolean;
}

/// What a media slot paints: one picture from the card's whole preview (a
/// picture, a link's page picture), one picture from its own tile (a post's
/// picture), one video (playing or its poster), or several media as a gallery
/// (Д21). The shape the slot is laid out at always comes from the artifact it
/// paints (SPEC_CARD_MEDIA_GEOMETRY.md).
export type CardMediaPaint =
  | { kind: "preview" }
  | { kind: "tile"; item: CardLayoutMediaItem | null }
  | { kind: "video" }
  | { kind: "gallery" };

/// A card's media (Е3).
export interface CardLayoutMedia {
  items: CardLayoutMediaItem[];
  /// The painted artifact's shape clamped from 1:2 to 2:1, the gallery's
  /// shape, or null while the artifact is not measured: the slot then takes
  /// the provisional envelope (`PROVISIONAL_MEDIA_ASPECT`).
  aspectRatio: number | null;
  visibleCount: number;
  totalCount: number;
  paint: CardMediaPaint;
}

/// A card's text (Е3); an empty string where the part is absent.
export interface CardLayoutText {
  title: string;
  text: string;
  author: string;
}

/// A card's content, read from its record (Е3).
export interface CardContent {
  source: CardSourceKind;
  media: CardLayoutMedia | null;
  text: CardLayoutText;
}

/// How the feed shows a card (Е2, Е11): one layout for every card, media on
/// top when shown and the text part under it.
export interface CardLayoutDescriptor {
  /// With content, or without (Е8): an empty card is the frame alone.
  mode: "content" | "empty";
  /// The media the card shows, or null.
  media: CardLayoutMedia | null;
  /// The card's text, whether the text part or the lift caption shows it.
  text: CardLayoutText;
  /// `always`: in the text part under the media (`Cards`, and every card
  /// without media). `on-lift`: only as the caption a lift brings up (`Media`
  /// with media, Е12).
  textShown: "always" | "on-lift";
  /// The text part stands under the shown media (Д20): the media then closes
  /// with its outline, the frame's ring mirrored under it.
  textUnderMedia: boolean;
}

export type CardLayoutBlock = Omit<LightBlock, "search_match" | "collections"> & {
  search_match?: LightBlock["search_match"];
  /// A feed card's collections, the pills under its text (SPEC_CARD_STATES.md,
  /// С9); a block read elsewhere (Detail) may not carry them.
  collections?: LightBlock["collections"];
};

export function getRuntimeCardKind(block: CardLayoutBlock): LightBlock["card_kind"] {
  const maybeKind = (block as Partial<LightBlock>).card_kind;
  if (
    maybeKind === "article"
    || maybeKind === "media"
    || maybeKind === "link"
    || maybeKind === "channel"
  ) {
    return maybeKind;
  }
  if (block.block_type === "channel") {
    return "channel";
  }
  if (block.body.trim()) {
    return "article";
  }
  if (
    block.media_file
    || block.block_type === "image"
    || block.block_type === "video"
    || block.block_type === "file"
  ) {
    return "media";
  }
  return block.url || block.block_type === "link" ? "link" : "article";
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Obsidian wikilink embeds (Phase 18.H.1): strip entirely — they are
    // media references, not prose.
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Obsidian wikilink text links (no leading `!`): keep the display
    // name if present after `|`, otherwise the target name.
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/// Longest body slice a card previews when the index carries no preview text.
const BODY_PREVIEW_MAX_CHARS = 400;

/// The body without its first heading, the card's title: the same cut the
/// index makes before it builds a preview (`strip_first_markdown_h1` in
/// mine-core), so the text never repeats the title above it.
function stripFirstMarkdownH1(body: string): string {
  const out: string[] = [];
  let inFence = false;
  let stripped = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && !stripped && trimmed.startsWith("# ")) {
      stripped = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trimStart();
}

/// A card's text under its title: the indexed preview, or the body's own words
/// after its title when the index has none. One rule for every record whose
/// body is its text.
function contentPreviewText(block: CardLayoutBlock, indexedPreviewText: string): string {
  return indexedPreviewText
    || stripMarkdown(stripFirstMarkdownH1(block.body)).slice(0, BODY_PREVIEW_MAX_CHARS).trim();
}

function isTwitterUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return (lc.includes("twitter.com/") || lc.includes("x.com/")) && lc.includes("/status/");
}

function isInstagramUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return lc.includes("instagram.com/p/") || lc.includes("instagram.com/reel/") || lc.includes("instagram.com/stories/");
}

function isSocialUrl(url: string | null): boolean {
  if (!url) return false;
  return isTwitterUrl(url) || isInstagramUrl(url);
}

function isVideoFile(src: string): boolean {
  return /\.mp4(\?|$)|\.webm(\?|$)|\.m4v(\?|$)|\.mov(\?|$)/i.test(src);
}

function isLocalImageFile(src: string): boolean {
  return !/^https?:\/\//i.test(src) && /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|heic|heif|avif)(\?|$)/i.test(src);
}

export function parsePreviewManifest(block: Pick<CardLayoutBlock, "preview_manifest">) {
  return normalizeFeedPreviewManifest(block.preview_manifest);
}

function aspectRatioFromDimensions(width: number | null | undefined, height: number | null | undefined): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

function mediaItemsFromManifestTiles(
  tiles: NormalizedFeedPreviewTile[],
): CardLayoutMediaItem[] {
  return tiles.map((tile) => ({
    sourcePath: tile.sourcePath,
    previewPath: tile.previewPath,
    // The artifact the card paints, never the source file. A preview may be
    // downscaled or clamped to a different shape than its original, and laying
    // out from the original then crops what is actually drawn. Null stays null:
    // an unmeasured tile is a state, not a shape.
    // See SPEC_CARD_MEDIA_GEOMETRY.md.
    aspectRatio: aspectRatioFromDimensions(tile.previewWidth, tile.previewHeight),
    isVideo: tile.isVideo,
    isVideoPoster: tile.isVideoPoster,
  }));
}

function galleryAspectRatio(itemCount: number): number {
  return itemCount === 2 ? 2 : 1;
}

function isEmbeddableVideoUrl(url: string | null): boolean {
  return parseYoutubeSource(url) !== null;
}

/// Ratio an image card renders its graphic at.
///
/// One source: the geometry of the artifact the feed actually paints, written
/// by the generator that produced it. No fallback chain — a card whose artifact
/// geometry is unknown is in a state of its own (see
/// `previewGeometryState`), not a card with an invented square.
/// Contract: `SPEC_CARD_MEDIA_GEOMETRY.md`.
function imageSurfaceAspectRatio(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): number | null {
  return aspectRatioFromDimensions(
    previewManifest?.previewWidth,
    previewManifest?.previewHeight,
  );
}

/// Shape a card's single painted artifact gives it: the preview's own geometry
/// (the whole preview, else its one tile), clamped into the card range, or null
/// while that artifact is not measured. Source dimensions are never read.
/// Shared by videos, a post's or an article's one video, and a link's page
/// picture. Contract: `SPEC_CARD_MEDIA_GEOMETRY.md`.
function singleArtifactAspectRatio(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  mediaItems: readonly CardLayoutMediaItem[],
): number | null {
  const artifactAspect = imageSurfaceAspectRatio(previewManifest) ?? mediaItems[0]?.aspectRatio ?? null;
  return artifactAspect === null ? null : clampCardAspect(artifactAspect);
}

/// Shape of the one media a post or an article paints, read from the image it
/// paints and clamped into the card range; null while that image is not
/// measured (SPEC_CARD_MEDIA_GEOMETRY.md; SPEC_AUDIT_FIXES.md, Д1.2, Д1.6).
/// A picture paints its own tile (`GalleryTileImage`), never the card's whole
/// preview: that one is built from `file`, then `thumbnail`, then the body, so
/// a page picture or a video poster kept in `thumbnail` has its own shape. A
/// video paints its poster, the whole preview first
/// (`buildFeedVideoPosterCandidates`), so it keeps that preview's shape.
function singleMediaAspectRatio(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  item: CardLayoutMediaItem,
): number | null {
  if (item.isVideo) return singleArtifactAspectRatio(previewManifest, [item]);
  return item.aspectRatio === null ? null : clampCardAspect(item.aspectRatio);
}


function hasVideoMediaSignal(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  mediaItems: CardLayoutMediaItem[],
): boolean {
  return (
    isEmbeddableVideoUrl(block.url) ||
    (block.media_file ? isVideoFile(block.media_file) : false) ||
    previewManifest?.kind === "video_poster" ||
    mediaItems.some((item) => item.isVideo || item.isVideoPoster)
  );
}

function hasImageMediaSignal(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): boolean {
  return (
    (block.media_file ? isLocalImageFile(block.media_file) : false) ||
    ((previewManifest?.kind === "image" || previewManifest?.kind === "composite") && !block.url) ||
    (block.width != null && block.height != null && block.width > 0 && block.height > 0 && !block.url) ||
    (!!previewManifest?.primaryPreviewPath && !block.url) ||
    (!!block.thumbnail && !block.url)
  );
}

/// A page picture or any other single picture the card's whole preview
/// holds: its own shape, clamped like every media (Е6), the tiles it was made
/// from as its items.
function previewPictureMedia(
  previewManifest: NonNullable<ReturnType<typeof parsePreviewManifest>>,
): CardLayoutMedia {
  const items = mediaItemsFromManifestTiles(previewManifest.tiles);
  return {
    items,
    aspectRatio: singleArtifactAspectRatio(previewManifest, items),
    visibleCount: items.length,
    totalCount: items.length + previewManifest.overflowCount,
    paint: { kind: "preview" },
  };
}

/// A record whose main file is a picture, a video or another file. Its title
/// is only a real heading: a legacy `frontmatter.title` on such a record
/// mirrors the file's name or the page it came from (SPEC_DISPLAY_TITLE.md).
function mediaRecordContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const text: CardLayoutText = {
    title: getMediaOwnTitle(block) ?? "",
    text: contentPreviewText(block, indexedPreviewText),
    author: block.author ?? "",
  };
  const items = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];

  if (hasVideoMediaSignal(block, previewManifest, items)) {
    // The poster's shape, clamped like any media; the artifact, or nothing:
    // the source file's size is never read (SPEC_CARD_MEDIA_GEOMETRY.md).
    return {
      source: "video",
      media: {
        items,
        aspectRatio: singleArtifactAspectRatio(previewManifest, items),
        visibleCount: items.length,
        totalCount: items.length,
        paint: { kind: "video" },
      },
      text,
    };
  }

  if (hasImageMediaSignal(block, previewManifest)) {
    const artifactAspect = imageSurfaceAspectRatio(previewManifest);
    return {
      source: "image",
      media: {
        items,
        // Null means the artifact has not been produced yet, and stays null:
        // the provisional envelope is the consumer's, not invented here.
        aspectRatio: artifactAspect === null ? null : clampCardAspect(artifactAspect),
        visibleCount: items.length,
        totalCount: items.length,
        paint: { kind: "preview" },
      },
      text,
    };
  }

  if (block.media_file) {
    // A file the preview generator made no picture of.
    return { source: "file", media: null, text };
  }

  if (block.url) {
    return {
      source: "link",
      media: previewManifest?.primaryPreviewPath && previewManifest.kind !== "text"
        ? previewPictureMedia(previewManifest)
        : null,
      text: { ...text, title: getDisplayTitle(block) ?? "" },
    };
  }

  return { source: "file", media: null, text };
}

/// A saved page: its page picture, its title and its description.
function linkContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const hasPagePicture = previewManifest !== null
    && previewManifest.kind !== "text"
    && previewManifest.primaryPreviewPath !== null;
  return {
    source: "link",
    media: hasPagePicture ? previewPictureMedia(previewManifest) : null,
    text: {
      title: getDisplayTitle(block) ?? "",
      text: indexedPreviewText,
      author: block.author ?? "",
    },
  };
}

/// An X or Instagram post: no title of its own (a legacy title there is
/// synthetic), its text, its author and its pictures or videos.
function socialContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const text: CardLayoutText = {
    title: "",
    text: indexedPreviewText || stripMarkdown((block.body.split(/^---+$/m)[0] ?? block.body).trim()),
    author: block.author ?? "",
  };
  const items = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];
  if (items.length === 0) {
    return { source: "social", media: null, text };
  }
  if (items.length === 1) {
    const item = items[0]!;
    return {
      source: "social",
      media: {
        items,
        // The shape of the image the card paints, clamped like every single
        // media (Г4.5, Д1.2); null while that image is not measured.
        aspectRatio: singleMediaAspectRatio(previewManifest, item),
        visibleCount: 1,
        totalCount: 1,
        paint: item.isVideo ? { kind: "video" } : { kind: "tile", item },
      },
      text,
    };
  }
  const totalCount = items.length + (previewManifest?.overflowCount ?? 0);
  return {
    source: "social",
    media: {
      items,
      aspectRatio: galleryAspectRatio(Math.min(4, totalCount)),
      visibleCount: Math.min(4, totalCount),
      totalCount,
      paint: { kind: "gallery" },
    },
    text,
  };
}

/// A post or an article: its title, its text, its author and the media its
/// preview was made from.
function articleContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const text: CardLayoutText = {
    title: getDisplayTitle(block) ?? "",
    text: contentPreviewText(block, indexedPreviewText),
    author: block.author ?? "",
  };
  const hasVisualPreview = previewManifest !== null && previewManifest.kind !== "text";
  if (!hasVisualPreview) {
    return { source: "article", media: null, text };
  }
  const items = mediaItemsFromManifestTiles(previewManifest.tiles);
  const totalCount = items.length + previewManifest.overflowCount;
  // Collages keep their own arrangement; a single media is shaped by the image
  // that is painted, and by nothing else (Д1.6). Null when that image has not
  // been measured: the consumer picks a provisional envelope rather than this
  // function inventing one from the source file.
  const single = totalCount === 1 ? items[0] : undefined;
  const aspectRatio = previewManifest.kind === "composite"
    ? galleryAspectRatio(Math.min(4, totalCount))
    : single
      ? singleMediaAspectRatio(previewManifest, single)
      : singleArtifactAspectRatio(previewManifest, items);
  const paint: CardMediaPaint = totalCount > 1
    ? { kind: "gallery" }
    : items.length === 1 && items[0]!.isVideo
      ? { kind: "video" }
      : { kind: "tile", item: items[0] ?? null };
  return {
    source: "article",
    media: { items, aspectRatio, visibleCount: items.length, totalCount, paint },
    text,
  };
}

/// A card's content, read from its record by that record's own data rules
/// (Е3). The same for every presentation.
export function deriveCardContent(block: CardLayoutBlock): CardContent {
  const previewManifest = parsePreviewManifest(block);
  const indexedPreviewText = block.preview_text?.trim() ?? "";
  const cardKind = getRuntimeCardKind(block);
  switch (cardKind) {
    case "media":
      return mediaRecordContent(block, previewManifest, indexedPreviewText);
    case "link":
      return linkContent(block, previewManifest, indexedPreviewText);
    case "channel":
      return {
        source: "channel",
        media: null,
        text: {
          title: getDisplayTitle(block) ?? "",
          text: contentPreviewText(block, indexedPreviewText),
          author: "",
        },
      };
    case "article":
      return isSocialUrl(block.url)
        ? socialContent(block, previewManifest, indexedPreviewText)
        : articleContent(block, previewManifest, indexedPreviewText);
  }
  const _never: never = cardKind;
  return _never;
}

/// Whether a card has any text of its own (Е3).
export function hasCardText(text: CardLayoutText): boolean {
  return Boolean(text.title || text.text || text.author);
}

/// The card in the feed's presentation (Е2, Е11). Every card follows the same
/// rules: what it has, it shows. `Media` shows a card's media alone and keeps
/// its text for the lift's caption; a card without media shows its text as in
/// `Cards`.
export function deriveCardLayoutDescriptor(
  block: CardLayoutBlock,
  show: FeedShow = "cards",
): CardLayoutDescriptor {
  const { media, text } = deriveCardContent(block);
  const textShown = show === "media" && media !== null ? "on-lift" : "always";
  // The pills under the text (С9) stand in the text part too, though they are
  // the card's links and not its content (Е4).
  const textPartShown = textShown === "always"
    && (hasCardText(text) || shownCollections({ collections: block.collections ?? [] }).length > 0);
  return {
    mode: media !== null || hasCardText(text) ? "content" : "empty",
    media,
    text,
    textShown,
    textUnderMedia: media !== null && textPartShown,
  };
}
