import type { LightBlock } from "@/types";
import {
  normalizeFeedPreviewManifest,
  type NormalizedFeedPreviewTile,
} from "@/lib/feedPreview";
import { getDisplayTitle } from "@/lib/displayTitle";
import { parseMediaDimensions } from "@/lib/mediaDimensions";
import { clampCardAspect } from "@/lib/cardAspect";

export type CardLayoutVariant =
  | "image"
  | "link"
  | "video"
  | "file"
  | "article-text"
  | "article-media"
  | "social-text"
  | "social-single-media"
  | "social-media-grid";

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

function parseAspectRatio(
  dims: ReturnType<typeof parseMediaDimensions>,
  filename: string | null | undefined,
): number | null {
  if (!dims || !filename) return null;
  const entry = dims[filename];
  if (!entry) return null;
  const [w, h] = entry;
  return w > 0 && h > 0 ? w / h : null;
}

function mediaItemsFromManifestTiles(
  tiles: NormalizedFeedPreviewTile[],
): CardLayoutMediaItem[] {
  return tiles.map((tile) => ({
    sourcePath: tile.sourcePath,
    previewPath: tile.previewPath,
    aspectRatio: aspectRatioFromDimensions(tile.width, tile.height),
    isVideo: tile.isVideo,
    isVideoPoster: tile.isVideoPoster,
  }));
}

function galleryAspectRatio(itemCount: number): number {
  return itemCount === 2 ? 2 : 1;
}

function isEmbeddableVideoUrl(url: string | null): boolean {
  if (!url) return false;
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/.test(url);
}

function mediaFileAspectRatio(block: CardLayoutBlock): number | null {
  return parseAspectRatio(parseMediaDimensions(block), block.media_file)
    ?? aspectRatioFromDimensions(block.width, block.height);
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
    return {
      variant: "video",
      titleText,
      previewText: "",
      authorText: "",
      primaryAspectRatio:
        mediaItems[0]?.aspectRatio ??
        aspectRatioFromDimensions(previewManifest?.width, previewManifest?.height) ??
        mediaFileAspectRatio(block) ??
        (16 / 9),
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
      primaryAspectRatio: 16 / 9,
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
        primaryAspectRatio: mediaItems[0]?.aspectRatio
          ?? aspectRatioFromDimensions(previewManifest?.width, previewManifest?.height)
          ?? 1,
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
  const primaryAspectRatio = previewManifest?.kind === "composite"
    ? galleryAspectRatio(Math.min(4, totalMediaCount))
    : aspectRatioFromDimensions(previewManifest?.width, previewManifest?.height) ?? (16 / 9);
  return {
    variant: hasVisualPreview ? "article-media" : "article-text",
    titleText,
    previewText: indexedPreviewText || stripMarkdown(block.body).slice(0, 400).trim(),
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
      primaryAspectRatio:
        aspectRatioFromDimensions(previewManifest.width, previewManifest.height) ?? (16 / 9),
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

export function deriveCardLayoutDescriptor(block: CardLayoutBlock): CardLayoutDescriptor {
  const titleText = getDisplayTitle(block) ?? "";
  const authorText = block.author ?? "";
  const previewManifest = parsePreviewManifest(block);
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
        previewText: indexedPreviewText || stripMarkdown(block.body).slice(0, 400).trim(),
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
