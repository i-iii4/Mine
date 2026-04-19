import type { LightBlock } from "@/types";
import {
  normalizeFeedPreviewManifest,
  type NormalizedFeedPreviewTile,
} from "@/lib/feedPreview";
import { parseMediaDimensions } from "@/lib/mediaDimensions";

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

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
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
  return /\.mp4(\?|$)|\.webm(\?|$)/i.test(src);
}

function isLocalImageFile(src: string): boolean {
  return !/^https?:\/\//i.test(src) && /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|heic|heif|avif)(\?|$)/i.test(src);
}

export function parsePreviewManifest(block: Pick<LightBlock, "preview_manifest">) {
  return normalizeFeedPreviewManifest(block.preview_manifest);
}

function aspectRatioFromDimensions(width: number | null | undefined, height: number | null | undefined): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

function extractArticlePreviewImageCount(block: LightBlock): number {
  if (!block.media_urls) return block.first_image && isLocalImageFile(block.first_image) ? 1 : 0;
  try {
    const urls: string[] = JSON.parse(block.media_urls);
    const count = urls.filter((src) => isLocalImageFile(src)).length;
    return count > 0 ? count : block.first_image && isLocalImageFile(block.first_image) ? 1 : 0;
  } catch {
    return block.first_image && isLocalImageFile(block.first_image) ? 1 : 0;
  }
}

function extractArticlePreviewMedia(block: LightBlock): CardLayoutMediaItem[] {
  const dims = parseMediaDimensions(block);

  if (block.media_urls) {
    try {
      const urls: string[] = JSON.parse(block.media_urls);
      const imageItems = urls
        .filter((src) => isLocalImageFile(src))
        .map((src) => ({
          sourcePath: src,
          previewPath: null,
          aspectRatio: parseAspectRatio(dims, src),
          isVideo: false,
          isVideoPoster: false,
        }));
      if (imageItems.length > 0) {
        return imageItems;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  if (block.first_image && isLocalImageFile(block.first_image)) {
    return [{
      sourcePath: block.first_image,
      previewPath: null,
      aspectRatio: parseAspectRatio(dims, block.first_image),
      isVideo: false,
      isVideoPoster: false,
    }];
  }

  return [];
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

function extractSocialMedia(block: LightBlock): CardLayoutMediaItem[] {
  const firstSection = block.body.split(/^---+$/m)[0] ?? block.body;
  const dims = parseMediaDimensions(block);
  const media: CardLayoutMediaItem[] = [];
  const lines = firstSection.split("\n");
  let nextIsVideoPoster = false;

  for (const line of lines) {
    if (line.trim() === "<!-- tweet-video -->") {
      nextIsVideoPoster = true;
      continue;
    }
    const imgMatch = line.match(/^!\[.*?\]\((.+?)\)$/);
    if (!imgMatch?.[1]) continue;
    const src = imgMatch[1];
    media.push({
      sourcePath: src,
      previewPath: null,
      aspectRatio: parseAspectRatio(dims, src),
      isVideo: isVideoFile(src) || nextIsVideoPoster,
      isVideoPoster: nextIsVideoPoster,
    });
    nextIsVideoPoster = false;
  }

  if (block.media_urls) {
    try {
      const urls: string[] = JSON.parse(block.media_urls);
      if (urls.length > media.length) {
        return urls.map((src) => ({
          sourcePath: src,
          previewPath: null,
          aspectRatio: parseAspectRatio(dims, src),
          isVideo: isVideoFile(src),
          isVideoPoster: false,
        }));
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return media;
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

export function deriveCardLayoutDescriptor(block: LightBlock): CardLayoutDescriptor {
  const titleText = block.title ?? block.slug;
  const authorText = block.author ?? "";
  const previewManifest = parsePreviewManifest(block);

  switch (block.block_type) {
    case "image": {
      const primaryAspectRatio =
        aspectRatioFromDimensions(previewManifest?.width ?? block.width, previewManifest?.height ?? block.height) ?? 1;
      return {
        variant: "image",
        titleText,
        previewText: "",
        authorText,
        primaryAspectRatio,
        mediaItems: [],
        visibleMediaCount: 0,
        totalMediaCount: 0,
      };
    }

    case "link":
      return {
        variant: "link",
        titleText,
        previewText: "",
        authorText: "",
        primaryAspectRatio: 16 / 9,
        mediaItems: [],
        visibleMediaCount: 0,
        totalMediaCount: 0,
      };

    case "video": {
      const mediaItems = previewManifest
        ? mediaItemsFromManifestTiles(previewManifest.tiles)
        : (block.media_file
          ? [{
            sourcePath: block.media_file,
            previewPath: null,
            aspectRatio: aspectRatioFromDimensions(block.width, block.height),
            isVideo: true,
            isVideoPoster: true,
          }]
          : []);
      return {
        variant: "video",
        titleText,
        previewText: "",
        authorText: "",
        primaryAspectRatio: aspectRatioFromDimensions(previewManifest?.width, previewManifest?.height) ?? (16 / 9),
        mediaItems,
        visibleMediaCount: mediaItems.length,
        totalMediaCount: mediaItems.length,
      };
    }

    case "file":
    case "channel":
      return {
        variant: block.block_type === "channel" ? "article-text" : "file",
        titleText,
        previewText: "",
        authorText: "",
        primaryAspectRatio: null,
        mediaItems: [],
        visibleMediaCount: 0,
        totalMediaCount: 0,
      };

    case "article": {
      if (isSocialUrl(block.url)) {
        const previewText = stripMarkdown((block.body.split(/^---+$/m)[0] ?? block.body).trim());
        const mediaItems = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : extractSocialMedia(block);
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
          primaryAspectRatio: aspectRatioFromDimensions(previewManifest?.width, previewManifest?.height),
          mediaItems,
          visibleMediaCount: Math.min(4, totalMediaCount),
          totalMediaCount,
        };
      }

      const firstImage = block.first_image ?? null;
      const imageCount = previewManifest
        ? previewManifest.tiles.length + previewManifest.overflowCount
        : extractArticlePreviewImageCount(block);
      const mediaItems = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : extractArticlePreviewMedia(block);
      const totalMediaCount = previewManifest
        ? mediaItems.length + previewManifest.overflowCount
        : imageCount;
      const hasVisualPreview = previewManifest
        ? previewManifest.kind !== "text"
        : imageCount > 0 || !!block.thumbnail || !!block.media_file;
      const primaryAspectRatio = previewManifest
        ? (previewManifest.kind === "composite"
          ? 1
          : aspectRatioFromDimensions(previewManifest.width, previewManifest.height) ?? (16 / 9))
        : (imageCount >= 2
          ? 1
          : parseAspectRatio(parseMediaDimensions(block), firstImage) ?? (16 / 9));
      return {
        variant: hasVisualPreview ? "article-media" : "article-text",
        titleText,
        previewText: stripMarkdown(block.body).slice(0, 400).trim(),
        authorText,
        primaryAspectRatio,
        mediaItems,
        visibleMediaCount: previewManifest ? mediaItems.length : imageCount,
        totalMediaCount,
      };
    }
  }

  const _never: never = block.block_type;
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
