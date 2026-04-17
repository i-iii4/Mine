import type { LightBlock } from "@/types";
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
  src: string;
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
      src,
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
          src,
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

export function deriveCardLayoutDescriptor(block: LightBlock): CardLayoutDescriptor {
  const titleText = block.title ?? block.slug;
  const authorText = block.author ?? "";

  switch (block.block_type) {
    case "image": {
      const primaryAspectRatio =
        block.width && block.height && block.width > 0 && block.height > 0
          ? block.width / block.height
          : 1;
      return {
        variant: "image",
        titleText,
        previewText: "",
        authorText,
        primaryAspectRatio,
        mediaItems: [],
        visibleMediaCount: 0,
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
      };

    case "video":
      return {
        variant: "video",
        titleText,
        previewText: "",
        authorText: "",
        primaryAspectRatio: 16 / 9,
        mediaItems: [],
        visibleMediaCount: 0,
      };

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
      };

    case "article": {
      if (isSocialUrl(block.url)) {
        const previewText = stripMarkdown((block.body.split(/^---+$/m)[0] ?? block.body).trim());
        const mediaItems = extractSocialMedia(block);
        if (mediaItems.length === 0) {
          return {
            variant: "social-text",
            titleText: "",
            previewText,
            authorText,
            primaryAspectRatio: null,
            mediaItems,
            visibleMediaCount: 0,
          };
        }
        if (mediaItems.length === 1) {
          return {
            variant: "social-single-media",
            titleText: "",
            previewText,
            authorText,
            primaryAspectRatio: mediaItems[0]?.aspectRatio ?? 1,
            mediaItems,
            visibleMediaCount: 1,
          };
        }
        return {
          variant: "social-media-grid",
          titleText: "",
          previewText,
          authorText,
          primaryAspectRatio: null,
          mediaItems,
          visibleMediaCount: Math.min(4, mediaItems.length),
        };
      }

      const firstImage = block.first_image ?? null;
      return {
        variant: firstImage ? "article-media" : "article-text",
        titleText,
        previewText: stripMarkdown(block.body).slice(0, 400).trim(),
        authorText,
        primaryAspectRatio: parseAspectRatio(parseMediaDimensions(block), firstImage) ?? (16 / 9),
        mediaItems: [],
        visibleMediaCount: 0,
      };
    }
  }

  const _never: never = block.block_type;
  return _never;
}
