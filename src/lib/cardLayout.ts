import type { LightBlock } from "@/types";
import {
  normalizeFeedPreviewManifest,
  type NormalizedFeedPreviewTile,
} from "@/lib/feedPreview";
import { getDisplayTitle, getNavigationLabel } from "@/lib/displayTitle";
import type { FeedShow } from "@/lib/feedDisplay";
import { clampCardAspect } from "@/lib/cardAspect";
import { parseYoutubeSource } from "@/lib/youtubeSource";

export type CardLayoutVariant =
  | "image"
  | "link"
  | "video"
  | "file"
  | "article-text"
  | "article-media"
  | "social-text"
  | "social-single-media"
  | "social-media-grid"
  /// `Media` presentation: the card's media alone, without frame text
  /// (SPEC_FEED_DISPLAY.md, Д13).
  | "media-only";

export interface CardLayoutMediaItem {
  sourcePath: string;
  previewPath: string | null;
  aspectRatio: number | null;
  isVideo: boolean;
  isVideoPoster: boolean;
}

export interface CardLayoutDescriptor {
  variant: CardLayoutVariant;
  titleText: string;
  previewText: string;
  authorText: string;
  primaryAspectRatio: number | null;
  mediaItems: CardLayoutMediaItem[];
  visibleMediaCount: number;
  totalMediaCount: number;
}

export interface ContentCardSlots {
  hasTopContent: boolean;
  hasMedia: boolean;
  hasBottomMeta: boolean;
}

export type CardLayoutBlock = Omit<LightBlock, "search_match"> & {
  search_match?: LightBlock["search_match"];
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

/// The text a framed card shows under its title: the indexed preview, or the
/// body's own words when the index has none. One rule for posts, collections
/// and pictures framed by `Cards` (SPEC_FEED_DISPLAY.md, Д12).
function contentPreviewText(block: CardLayoutBlock, indexedPreviewText: string): string {
  return indexedPreviewText || stripMarkdown(block.body).slice(0, BODY_PREVIEW_MAX_CHARS).trim();
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
/// picture shown alone in `Media`. Contract: `SPEC_CARD_MEDIA_GEOMETRY.md`.
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

/// The fixed slot a framed link paints its page picture in, whatever the
/// picture's shape: `aspect-video` in `LinkCard`, `THUMBNAIL_ASPECT` in
/// `cardHeight.ts` (SPEC_GRID.md). Only `Media` shows the picture at its own
/// shape (SPEC_FEED_DISPLAY.md, Д11 to Д14).
const LINK_THUMBNAIL_ASPECT = 16 / 9;

function mediaItemsFromMediaMetadata(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): CardLayoutMediaItem[] {
  if (previewManifest) {
    return mediaItemsFromManifestTiles(previewManifest.tiles);
  }
  return [];
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

function deriveMediaCardLayoutDescriptor(
  block: CardLayoutBlock,
  titleText: string,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): CardLayoutDescriptor {
  const mediaItems = mediaItemsFromMediaMetadata(previewManifest);

  if (hasVideoMediaSignal(block, previewManifest, mediaItems)) {
    // The poster's shape, clamped like a post's media: a fixed 16:9 slot
    // cropped square and vertical videos to their middle (30.09.2026). The
    // artifact, or nothing; the source file's size is never read.
    // See SPEC_CARD_MEDIA_GEOMETRY.md.
    return {
      variant: "video",
      titleText,
      previewText: "",
      authorText: "",
      primaryAspectRatio: singleArtifactAspectRatio(previewManifest, mediaItems),
      mediaItems,
      visibleMediaCount: mediaItems.length,
      totalMediaCount: mediaItems.length,
    };
  }

  if (hasImageMediaSignal(block, previewManifest)) {
    const artifactAspect = imageSurfaceAspectRatio(previewManifest);
    return {
      variant: "image",
      titleText,
      previewText: "",
      authorText: "",
      // Null means the artifact has not been produced yet, and stays null: the
      // provisional envelope is chosen by the consumer, not invented here.
      primaryAspectRatio: artifactAspect === null ? null : clampCardAspect(artifactAspect),
      mediaItems,
      visibleMediaCount: mediaItems.length,
      totalMediaCount: mediaItems.length,
    };
  }

  if (block.media_file) {
    return {
      variant: "file",
      titleText,
      previewText: "",
      authorText: "",
      primaryAspectRatio: null,
      mediaItems,
      visibleMediaCount: mediaItems.length,
      totalMediaCount: mediaItems.length,
    };
  }

  if (block.url) {
    return {
      variant: "link",
      titleText,
      previewText: "",
      authorText: "",
      primaryAspectRatio: LINK_THUMBNAIL_ASPECT,
      mediaItems,
      visibleMediaCount: mediaItems.length,
      totalMediaCount: mediaItems.length,
    };
  }

  return {
    variant: "file",
    titleText,
    previewText: "",
    authorText: "",
    primaryAspectRatio: null,
    mediaItems,
    visibleMediaCount: mediaItems.length,
    totalMediaCount: mediaItems.length,
  };
}

function deriveArticleCardLayoutDescriptor(
  block: CardLayoutBlock,
  titleText: string,
  authorText: string,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardLayoutDescriptor {
  if (isSocialUrl(block.url)) {
    const previewText = indexedPreviewText || stripMarkdown((block.body.split(/^---+$/m)[0] ?? block.body).trim());
    const mediaItems = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];
    if (mediaItems.length === 0) {
      return {
        variant: "social-text",
        titleText: "",
        previewText,
        authorText,
        primaryAspectRatio: null,
        mediaItems,
        visibleMediaCount: 0,
        totalMediaCount: 0,
      };
    }
    if (mediaItems.length === 1) {
      return {
        variant: "social-single-media",
        titleText: "",
        previewText,
        authorText,
        // The shape of the image the card paints, clamped into 1:2 to 2:1 like
        // every other single media (Г4.5, Д1.2). Null when that image has not
        // been measured yet, and stays null: substituting the source's shape
        // would lay the card out from a file it never paints; substituting 1
        // would state a square nobody knows.
        primaryAspectRatio: singleMediaAspectRatio(previewManifest, mediaItems[0]!),
        mediaItems,
        visibleMediaCount: 1,
        totalMediaCount: 1,
      };
    }
    const totalMediaCount = mediaItems.length + (previewManifest?.overflowCount ?? 0);
    return {
      variant: "social-media-grid",
      titleText: "",
      previewText,
      authorText,
      primaryAspectRatio: galleryAspectRatio(Math.min(4, totalMediaCount)),
      mediaItems,
      visibleMediaCount: Math.min(4, totalMediaCount),
      totalMediaCount,
    };
  }

  const mediaItems = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];
  const totalMediaCount = previewManifest
    ? mediaItems.length + previewManifest.overflowCount
    : 0;
  const hasVisualPreview = previewManifest?.kind !== undefined && previewManifest.kind !== "text";
  // Collages keep their own arrangement; a single media is shaped by the image
  // that is painted, and by nothing else (Д1.6). Null when that image has not
  // been measured: the consumer picks a provisional envelope rather than this
  // function inventing one from the source file.
  const singleMedia = totalMediaCount === 1 ? mediaItems[0] : undefined;
  const primaryAspectRatio = previewManifest?.kind === "composite"
    ? galleryAspectRatio(Math.min(4, totalMediaCount))
    : singleMedia
      ? singleMediaAspectRatio(previewManifest, singleMedia)
      : singleArtifactAspectRatio(previewManifest, mediaItems);
  return {
    variant: hasVisualPreview ? "article-media" : "article-text",
    titleText,
    previewText: contentPreviewText(block, indexedPreviewText),
    authorText,
    primaryAspectRatio,
    mediaItems,
    visibleMediaCount: mediaItems.length,
    totalMediaCount,
  };
}

function deriveLinkCardLayoutDescriptor(
  titleText: string,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardLayoutDescriptor {
  const mediaItems = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];
  const hasVisualPreview = previewManifest?.kind !== undefined
    && previewManifest.kind !== "text"
    && previewManifest.primaryPreviewPath !== null;
  if (hasVisualPreview) {
    return {
      variant: "link",
      titleText,
      previewText: indexedPreviewText,
      authorText: "",
      // The framed slot, not the picture's shape: `Media` reshapes it from the
      // artifact (`asMediaOnly`), and the source's size is never card geometry
      // (SPEC_CARD_MEDIA_GEOMETRY.md; SPEC_AUDIT_FIXES.md, В5.7).
      primaryAspectRatio: LINK_THUMBNAIL_ASPECT,
      mediaItems,
      visibleMediaCount: mediaItems.length,
      totalMediaCount: mediaItems.length + previewManifest.overflowCount,
    };
  }

  return {
    variant: "link",
    titleText,
    previewText: indexedPreviewText,
    authorText: "",
    primaryAspectRatio: null,
    mediaItems: [],
    visibleMediaCount: 0,
    totalMediaCount: 0,
  };
}

/// The card's layout in the feed's presentation (SPEC_FEED_DISPLAY.md, Д10 to
/// Д14). `mixed` is the feed as it has always been; the other two are derived
/// from it, so each card keeps one geometry per presentation.
export function deriveCardLayoutDescriptor(
  block: CardLayoutBlock,
  show: FeedShow = "mixed",
): CardLayoutDescriptor {
  const previewManifest = parsePreviewManifest(block);
  const mixed = deriveMixedCardLayoutDescriptor(block, previewManifest);
  if (show === "cards") return asPostCard(block, mixed);
  if (show === "media") return asMediaOnly(mixed, previewManifest);
  return mixed;
}

/// `Cards`: a picture or video card becomes a post card, its media inset in the
/// frame and under it its name (the title, or the file name without one), its
/// text and its author when it has them (Д12). Every other card is framed
/// already.
function asPostCard(block: CardLayoutBlock, mixed: CardLayoutDescriptor): CardLayoutDescriptor {
  if (mixed.variant !== "image" && mixed.variant !== "video") return mixed;
  return {
    ...mixed,
    variant: "article-media",
    titleText: getNavigationLabel(block),
    previewText: contentPreviewText(block, block.preview_text?.trim() ?? ""),
    authorText: block.author ?? "",
  };
}

const MEDIA_BEARING_VARIANTS: ReadonlySet<CardLayoutVariant> = new Set([
  "article-media",
  "social-single-media",
  "social-media-grid",
]);

/// `Media`: a card with media shows only its media; several media stay the
/// usual gallery. A link's page picture is media like any other (Д13, Д14):
/// it leaves the framed link's fixed slot and takes its own artifact's shape,
/// like a post's single media, the provisional envelope until it is measured.
function asMediaOnly(
  mixed: CardLayoutDescriptor,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): CardLayoutDescriptor {
  const linkPicture = mixed.variant === "link" && mixed.mediaItems.length > 0;
  if (!MEDIA_BEARING_VARIANTS.has(mixed.variant) && !linkPicture) return mixed;
  return {
    ...mixed,
    variant: "media-only",
    titleText: "",
    previewText: "",
    authorText: "",
    primaryAspectRatio: linkPicture
      ? singleArtifactAspectRatio(previewManifest, mixed.mediaItems)
      : mixed.primaryAspectRatio,
  };
}

function deriveMixedCardLayoutDescriptor(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): CardLayoutDescriptor {
  const titleText = getDisplayTitle(block) ?? "";
  const authorText = block.author ?? "";
  const indexedPreviewText = block.preview_text?.trim() ?? "";
  const cardKind = getRuntimeCardKind(block);

  switch (cardKind) {
    case "media":
      return deriveMediaCardLayoutDescriptor(block, titleText, previewManifest);

    case "link":
      return deriveLinkCardLayoutDescriptor(
        titleText,
        previewManifest,
        indexedPreviewText,
      );

    case "channel":
      return {
        variant: "article-text",
        titleText,
        previewText: contentPreviewText(block, indexedPreviewText),
        authorText: "",
        primaryAspectRatio: null,
        mediaItems: [],
        visibleMediaCount: 0,
        totalMediaCount: 0,
      };

    case "article":
      return deriveArticleCardLayoutDescriptor(
        block,
        titleText,
        authorText,
        previewManifest,
        indexedPreviewText,
      );
  }

  const _never: never = cardKind;
  return _never;
}

export function deriveContentCardSlots(
  descriptor: CardLayoutDescriptor,
): ContentCardSlots | null {
  switch (descriptor.variant) {
    case "article-text":
    case "article-media":
      return {
        hasTopContent: descriptor.titleText.length > 0 || descriptor.previewText.length > 0,
        hasMedia: descriptor.variant === "article-media",
        hasBottomMeta: descriptor.authorText.length > 0,
      };
    case "social-text":
    case "social-single-media":
    case "social-media-grid":
      return {
        hasTopContent: descriptor.previewText.length > 0,
        hasMedia: descriptor.variant !== "social-text",
        hasBottomMeta: descriptor.authorText.length > 0,
      };
    default:
      return null;
  }
}
