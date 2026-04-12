import { useState, useEffect, useMemo, memo, createContext, useContext } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ImageOff } from "lucide-react";
import type { LightBlock } from "@/types";
import { thumbnailUrl, mediaUrl, domainFromUrl } from "@/lib/assets";
import { getMediaAspectRatio, getMediaDimensionsMap } from "@/lib/mediaDimensions";
import { VideoFromBlob } from "./VideoFromBlob";
import { cn } from "@/lib/utils";
import { CardHoverMenu } from "./CardHoverMenu";

const PriorityContext = createContext(false);
const usePriority = () => useContext(PriorityContext);

interface CardProps {
  block: LightBlock;
  vaultPath: string;
  isFocused?: boolean;
  priority?: boolean;
  onClick: (block: LightBlock) => void;
  tags?: import("@/types").TagCount[];
  currentTag?: string;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void;
  onRequestDelete?: (slug: string) => void;
}

export const Card = memo(function Card({ block, vaultPath, isFocused, priority, onClick, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestDelete }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: block.slug,
  });

  const handleClick = () => onClick(block);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(block);
    }
  };

  return (
    <div
      ref={setNodeRef}
      data-block-slug={block.slug}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group cursor-pointer overflow-hidden border border-border relative rounded-[var(--radius-card)]",
        isDragging && "opacity-30",
        isFocused && "ring-2 ring-ring",
      )}
    >
      {tags && onToggleTag && onCreateAndAssign && onRequestDelete && (
        <CardHoverMenu
          block={block}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestDelete={onRequestDelete}
        />
      )}
      <CardContent block={block} vaultPath={vaultPath} priority={priority} />
    </div>
  );
});

function isTwitterUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return (lc.includes("twitter.com/") || lc.includes("x.com/")) && lc.includes("/status/");
}

function isInstagramUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return lc.includes("instagram.com/p/") || lc.includes("instagram.com/reel/") || lc.includes("instagram.com/stories/");
}

export function CardContent({
  block,
  vaultPath,
  priority,
}: {
  block: LightBlock;
  vaultPath: string;
  priority?: boolean;
}) {
  const content = (() => {
    switch (block.block_type) {
      case "image":
        return <ImageCard block={block} vaultPath={vaultPath} />;
      case "link":
        return <LinkCard block={block} vaultPath={vaultPath} />;
      case "article":
        if (block.url && (isTwitterUrl(block.url) || isInstagramUrl(block.url))) {
          return <SocialCard block={block} vaultPath={vaultPath} />;
        }
        return <ArticleCard block={block} vaultPath={vaultPath} />;
      case "video":
        return <VideoCard block={block} vaultPath={vaultPath} />;
      case "file":
        return <FileCard block={block} />;
    }
  })();
  return (
    <PriorityContext.Provider value={!!priority}>
      {content}
    </PriorityContext.Provider>
  );
}

const ImageCard = memo(function ImageCard({
  block,
  vaultPath,
}: {
  block: LightBlock;
  vaultPath: string;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const [error, setError] = useState(false);
  const hasDimensions = !!(block.width && block.height && block.width > 0 && block.height > 0);
  const src = block.media_file
    ? mediaUrl(vaultPath, block.media_file)
    : thumbnailUrl(vaultPath, block.slug);

  // Retry failed loads when vault data refreshes (e.g. iCloud files downloaded)
  useEffect(() => {
    if (!error) return;
    const handler = () => setError(false);
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [error]);

  if (error) {
    return (
      <div className="flex aspect-square items-center justify-center bg-accent">
        <div className="text-center">
          <ImageOff className="mx-auto size-6 text-muted-foreground/50" />
          <p className="mt-1 text-sm text-foreground">
            {block.title ?? block.slug}
          </p>
        </div>
      </div>
    );
  }

  // Aspect ratio is ALWAYS set — either from metadata (accurate) or a square
  // fallback (neutral default when metadata is missing). This makes the card
  // layout deterministic before the image loads, which is required for the
  // hidden DOM measurement pass in Grid.tsx to read a stable height.
  const aspectRatio = hasDimensions
    ? `${block.width} / ${block.height}`
    : "1 / 1";

  return (
    <div
      className="relative overflow-hidden bg-accent"
      style={{ aspectRatio }}
    >
      <img
        src={src}
        alt={block.title ?? block.slug}
        className="absolute inset-0 h-full w-full object-cover"
        loading={imgLoading}
        onError={() => setError(true)}
      />
    </div>
  );
});

const LINK_COLORS = [
  "bg-blue-900", "bg-emerald-900", "bg-violet-900", "bg-amber-900",
  "bg-rose-900", "bg-cyan-900", "bg-indigo-900", "bg-teal-900",
];

const LinkCard = memo(function LinkCard({
  block,
  vaultPath,
}: {
  block: LightBlock;
  vaultPath: string;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const thumb = thumbnailUrl(vaultPath, block.slug);
  const domain = block.url ? domainFromUrl(block.url) : null;

  // Retry failed loads when vault data refreshes (e.g. iCloud files downloaded)
  useEffect(() => {
    if (!thumbError) return;
    const handler = () => {
      setThumbLoaded(false);
      setThumbError(false);
    };
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [thumbError]);

  // No thumbnail — compact card (title + domain only)
  if (thumbError) {
    return (
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-foreground">
          {block.title ?? block.slug}
        </p>
        {domain && (
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{domain}</p>
        )}
      </div>
    );
  }

  const initial = (domain ?? block.slug).charAt(0).toUpperCase();
  const colorIdx = block.slug.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const bgColor = LINK_COLORS[colorIdx % LINK_COLORS.length]!;

  return (
    <div className="flex flex-col">
      <div className={`relative aspect-video ${bgColor}`}>
        {!thumbLoaded && (
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <span className="text-lg font-semibold text-white/40">{initial}</span>
            {domain && (
              <span className="text-sm text-white/30">{domain}</span>
            )}
          </div>
        )}
        <img
          src={thumb}
          alt=""
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity",
            thumbLoaded ? "opacity-100" : "opacity-0",
          )}
          loading={imgLoading}
          onLoad={() => setThumbLoaded(true)}
          onError={() => setThumbError(true)}
        />
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-foreground">
          {block.title ?? block.slug}
        </p>
        {domain && (
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{domain}</p>
        )}
      </div>
    </div>
  );
});

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

interface TweetMedia {
  src: string;
  isVideo: boolean; // true = GIF (local .mp4) or video poster with play overlay
  isVideoPoster: boolean; // true = HLS video poster (not downloadable), show play icon
}

function extractTweetData(body: string): { text: string; media: TweetMedia[] } {
  const firstSection = body.split(/^---+$/m)[0] ?? body;
  const media: TweetMedia[] = [];
  // Match both regular images and video-poster-marked images
  const lines = firstSection.split("\n");
  let nextIsVideoPoster = false;
  for (const line of lines) {
    if (line.trim() === "<!-- tweet-video -->") {
      nextIsVideoPoster = true;
      continue;
    }
    const imgMatch = line.match(/^!\[.*?\]\((.+?)\)$/);
    if (imgMatch?.[1]) {
      const src = imgMatch[1];
      const isVideoFile = /\.mp4(\?|$)|\.webm(\?|$)/i.test(src);
      media.push({
        src,
        isVideo: isVideoFile || nextIsVideoPoster,
        isVideoPoster: nextIsVideoPoster,
      });
      nextIsVideoPoster = false;
    }
  }
  const text = stripMarkdown(firstSection).trim();
  return { text, media };
}

function isVideoFile(src: string): boolean {
  return /\.mp4(\?|$)|\.webm(\?|$)/i.test(src);
}

const SocialCard = memo(function SocialCard({ block, vaultPath }: { block: LightBlock; vaultPath: string }) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const { text, media } = useMemo(() => extractTweetData(block.body), [block.body]);
  const dimsMap = useMemo(() => getMediaDimensionsMap(block), [block]);

  // If body was truncated and lost media references, use media_urls from index
  if (media.length === 0 && block.media_urls) {
    try {
      const urls: string[] = JSON.parse(block.media_urls);
      for (const src of urls) {
        media.push({ src, isVideo: isVideoFile(src), isVideoPoster: false });
      }
    } catch { /* invalid JSON — skip */ }
  }

  const resolveSrc = (src: string) =>
    src.startsWith("http://") || src.startsWith("https://") ? src : mediaUrl(vaultPath, src);

  /** Aspect ratio for a single media item, indexed by its filename. */
  const aspectFor = (src: string, fallback: string): string => {
    if (!dimsMap) return fallback;
    const entry = dimsMap[src];
    if (!entry) return fallback;
    return `${entry[0]} / ${entry[1]}`;
  };

  return (
    <div className="p-4">
      {text && (
        <p className="line-clamp-3 text-sm text-muted-foreground">{text}</p>
      )}

      {media.length === 1 && (() => {
        // Exact aspect-ratio from the indexer when available, aspect-square
        // fallback otherwise. object-contain renders the full image without
        // cropping, sitting inside the exact-ratio wrapper.
        const m = media[0]!;
        const resolved = resolveSrc(m.src);
        const absClass = "absolute inset-0 h-full w-full object-contain";
        return (
          <div
            className="mt-3 relative w-full overflow-hidden bg-accent"
            style={{ aspectRatio: aspectFor(m.src, "1 / 1") }}
          >
            {isVideoFile(m.src) ? (
              <VideoFromBlob
                src={resolved}
                className={absClass}
                autoPlay
                loop
                muted
              />
            ) : (
              <img
                src={resolved}
                alt=""
                className={absClass}
                loading={imgLoading}
              />
            )}
            {m.isVideoPoster && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2.5v11l10-5.5L4 2.5z" />
                  </svg>
                </div>
              </div>
            )}
          </div>
        );
      })()}
      {media.length >= 2 && (
        <div className="mt-3 grid grid-cols-2 gap-0.5">
          {media.slice(0, 4).map((m) => {
            const resolved = resolveSrc(m.src);
            const absClass = "absolute inset-0 h-full w-full object-contain";
            return (
              <div
                key={m.src}
                className="relative overflow-hidden bg-accent"
                style={{ aspectRatio: aspectFor(m.src, "1 / 1") }}
              >
                {isVideoFile(m.src) ? (
                  <VideoFromBlob
                    src={resolved}
                    className={absClass}
                    autoPlay
                    loop
                    muted
                  />
                ) : (
                  <img
                    src={resolved}
                    alt=""
                    className={absClass}
                    loading={imgLoading}
                  />
                )}
                {m.isVideoPoster && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 2.5v11l10-5.5L4 2.5z" />
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {block.author && (
        <p className="mt-2 text-sm text-muted-foreground">by {block.author}</p>
      )}
    </div>
  );
});

function isImageFile(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(name);
}

const ArticleCard = memo(function ArticleCard({ block, vaultPath }: { block: LightBlock; vaultPath: string }) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const preview = useMemo(() => stripMarkdown(block.body).slice(0, 400).trim(), [block.body]);
  const firstImage = block.first_image && isImageFile(block.first_image) ? block.first_image : null;
  const hasImage = !!firstImage;

  return (
    <div className="p-4">
      <p
        className="line-clamp-2 text-sm font-semibold text-foreground"
        style={{ lineHeight: "16px" }}
      >
        {block.title ?? block.slug}
      </p>
      {preview && (
        <p
          className={cn(
            "mt-1.5 text-sm text-muted-foreground",
            hasImage ? "line-clamp-3" : "line-clamp-8",
          )}
          style={{ lineHeight: "20px" }}
        >
          {preview}
        </p>
      )}
      {firstImage && (
        // Exact aspect-ratio from the indexer's media_dimensions when
        // available (images extracted from body at index time), or
        // aspect-video fallback for older/unreindexed blocks. object-contain
        // renders the image at its natural shape inside the exact-ratio
        // wrapper, so nothing is cropped.
        <div
          className="relative mt-3 w-full overflow-hidden bg-accent"
          style={{ aspectRatio: getMediaAspectRatio(block, firstImage, "16 / 9") }}
        >
          <img
            src={mediaUrl(vaultPath, firstImage)}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
            loading={imgLoading}
          />
        </div>
      )}
      {block.author && (
        <p
          className="mt-2 text-sm text-muted-foreground"
          style={{ lineHeight: "16px" }}
        >
          {block.author}
        </p>
      )}
    </div>
  );
});

const VideoCard = memo(function VideoCard({
  block,
  vaultPath,
}: {
  block: LightBlock;
  vaultPath: string;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const thumb = thumbnailUrl(vaultPath, block.slug);

  return (
    <div className="relative aspect-video">
      <img
        src={thumb}
        alt=""
        className="h-full w-full object-cover"
        loading={imgLoading}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-1 bg-black/50 text-white">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2.5v11l10-5.5L4 2.5z" />
          </svg>
        </div>
      </div>
    </div>
  );
});

const FileCard = memo(function FileCard({ block }: { block: LightBlock }) {
  const ext = block.media_file
    ?.split(".")
    .pop()
    ?.toUpperCase();

  return (
    <div className="flex items-center gap-3 p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-1 bg-accent text-sm font-semibold text-muted-foreground">
        {ext ?? "FILE"}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">
          {block.title ?? block.slug}
        </p>
        {block.media_file && (
          <p className="truncate text-sm text-muted-foreground">
            {block.media_file}
          </p>
        )}
      </div>
    </div>
  );
});
