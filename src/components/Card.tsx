import { useState, useEffect, useMemo, memo, createContext, useContext, forwardRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ImageOff } from "lucide-react";
import type { LightBlock } from "@/types";
import {
  thumbnailUrl,
  mediaUrl,
  previewAssetUrl,
  domainFromUrl,
  legacyThumbsRoot,
} from "@/lib/assets";
import { deriveCardLayoutDescriptor, type CardLayoutDescriptor } from "@/lib/cardLayout";
import { cn } from "@/lib/utils";
import { CardHoverMenu } from "./CardHoverMenu";
import { VideoFromBlob } from "./VideoFromBlob";

const PriorityContext = createContext(false);
const usePriority = () => useContext(PriorityContext);

interface CardProps {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  isFocused?: boolean;
  priority?: boolean;
  onClick: (block: LightBlock) => void;
  tags?: import("@/types").TagCount[];
  currentTag?: string;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void;
  onRequestDelete?: (slug: string) => void;
}

const CARD_FRAME_CLASS =
  "group relative overflow-hidden border border-border rounded-[var(--radius-card)] bg-background";

interface CardFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const CardFrame = forwardRef<HTMLDivElement, CardFrameProps>(function CardFrame(
  { children, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(CARD_FRAME_CLASS, className)}
      {...props}
    >
      {children}
    </div>
  );
});

export function MeasuredCardFrame({
  children,
  className,
  ...props
}: CardFrameProps) {
  return (
    <CardFrame className={cn("h-full", className)} {...props}>
      {children}
    </CardFrame>
  );
}

export const Card = memo(function Card({ block, vaultPath, thumbsRootPath, isFocused, priority, onClick, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestDelete }: CardProps) {
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
    <CardFrame
      ref={setNodeRef}
      data-block-slug={block.slug}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "h-full cursor-pointer",
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
      <CardContent block={block} vaultPath={vaultPath} thumbsRootPath={thumbsRootPath} priority={priority} />
    </CardFrame>
  );
});

export const CardSkeleton = memo(function CardSkeleton({
  block,
}: {
  block: LightBlock;
}) {
  const descriptor = useMemo(() => deriveCardLayoutDescriptor(block), [block]);
  const hasMedia =
    descriptor.variant === "image" ||
    descriptor.variant === "video" ||
    descriptor.variant === "link" ||
    descriptor.variant === "article-media" ||
    descriptor.variant === "social-single-media" ||
    descriptor.variant === "social-media-grid";

  return (
    <MeasuredCardFrame className="h-full">
      <div className="flex h-full flex-col p-4">
        <div className="h-4 w-2/3 rounded-[2px] bg-accent" />
        {descriptor.previewText && (
          <>
            <div className="mt-2 h-3 w-full rounded-[2px] bg-accent" />
            <div className="mt-1.5 h-3 w-5/6 rounded-[2px] bg-accent" />
          </>
        )}
        {hasMedia && (
          <div
            className="mt-3 w-full rounded-[2px] bg-accent"
            style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? 1}` }}
          />
        )}
        {descriptor.authorText && (
          <div className="mt-2 h-3 w-1/3 rounded-[2px] bg-accent" />
        )}
      </div>
    </MeasuredCardFrame>
  );
});

export function CardContent({
  block,
  vaultPath,
  thumbsRootPath,
  priority,
  measurementMode = false,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  priority?: boolean;
  measurementMode?: boolean;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);
  const descriptor = useMemo(() => deriveCardLayoutDescriptor(block), [block]);
  const content = (() => {
    switch (descriptor.variant) {
      case "image":
        return <ImageCard block={block} descriptor={descriptor} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
      case "link":
        return <LinkCard block={block} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
      case "article-text":
      case "article-media":
        return <ArticleCard block={block} descriptor={descriptor} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
      case "social-text":
      case "social-single-media":
      case "social-media-grid":
        return <SocialCard block={block} descriptor={descriptor} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
      case "video":
        return <VideoCard block={block} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
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

function resolveFeedMediaSrc(vaultPath: string, src: string): string {
  return src.startsWith("http://") || src.startsWith("https://") ? src : mediaUrl(vaultPath, src);
}

function resolveFeedPreviewSrc(
  thumbsRootPath: string,
  previewPath: string | null,
  fallbackSlug: string,
): string {
  return previewPath
    ? previewAssetUrl(thumbsRootPath, previewPath)
    : thumbnailUrl(thumbsRootPath, fallbackSlug);
}

function isPlayableVideoSrc(src: string): boolean {
  return /\.mp4(\?|$)|\.webm(\?|$)|\.m4v(\?|$)|\.mov(\?|$)/i.test(src);
}

function renderFeedVideo(vaultPath: string, src: string, className: string) {
  return (
    <VideoFromBlob
      src={resolveFeedMediaSrc(vaultPath, src)}
      className={className}
      autoPlay
      loop
      muted
    />
  );
}

function PlayBadge() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2.5v11l10-5.5L4 2.5z" />
        </svg>
      </div>
    </div>
  );
}

function GalleryTiles({
  items,
  vaultPath,
  thumbsRootPath,
  fallbackSlug,
  measurementMode,
}: {
  items: CardLayoutDescriptor["mediaItems"];
  vaultPath: string;
  thumbsRootPath: string;
  fallbackSlug: string;
  measurementMode: boolean;
}) {
  const visibleItems = items.slice(0, 4);
  const count = visibleItems.length;
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;

  if (count === 0) {
    return null;
  }

  const gridStyle =
    count === 2
      ? { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr" }
      : { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };

  return (
    <div className="absolute inset-0 grid gap-[2px] bg-background" style={gridStyle}>
      {visibleItems.map((item, index) => {
        const tileStyle = count === 3 && index === 0 ? { gridRow: "1 / span 2" } : undefined;
        const tilePreviewSrc = resolveFeedPreviewSrc(
          thumbsRootPath,
          item.previewPath,
          fallbackSlug,
        );

        return (
          <div key={`${item.sourcePath}-${index}`} className="relative overflow-hidden bg-accent" style={tileStyle}>
            {!measurementMode && !item.isVideo && (
              <img
                src={tilePreviewSrc}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                loading={imgLoading}
              />
            )}
            {!measurementMode && item.isVideoPoster && !item.isVideo && <PlayBadge />}
            {!measurementMode && item.isVideo && isPlayableVideoSrc(item.sourcePath) && (
              <>
                {renderFeedVideo(vaultPath, item.sourcePath, "absolute inset-0 h-full w-full object-cover")}
                <PlayBadge />
              </>
            )}
            {(measurementMode || (item.isVideo && !isPlayableVideoSrc(item.sourcePath))) && (
              <div className="absolute inset-0 bg-accent" />
            )}
          </div>
        );
      })}
    </div>
  );
}

const ImageCard = memo(function ImageCard({
  block,
  descriptor,
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const [error, setError] = useState(false);
  const src = thumbnailUrl(thumbsRootPath, block.slug);

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
  const aspectRatio = descriptor.primaryAspectRatio
    ? `${descriptor.primaryAspectRatio}`
    : "1";

  return (
    <div
      className="relative overflow-hidden bg-accent"
      style={{ aspectRatio }}
    >
      {!measurementMode && (
        <img
          src={src}
          alt={block.title ?? block.slug}
          className="absolute inset-0 h-full w-full object-cover"
          loading={imgLoading}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
});

const LINK_COLORS = [
  "bg-blue-900", "bg-emerald-900", "bg-violet-900", "bg-amber-900",
  "bg-rose-900", "bg-cyan-900", "bg-indigo-900", "bg-teal-900",
];

const LinkCard = memo(function LinkCard({
  block,
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const thumb = thumbnailUrl(thumbsRootPath, block.slug);
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
        {!measurementMode && (
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
        )}
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

const SocialCard = memo(function SocialCard({
  block,
  descriptor,
  vaultPath,
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  vaultPath: string;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const text = descriptor.previewText;
  const media = descriptor.mediaItems;
  const previewSrc = thumbnailUrl(thumbsRootPath, block.slug);

  return (
    <div className="p-4">
      {text && (
        <p className="line-clamp-3 text-sm text-muted-foreground">{text}</p>
      )}

      {descriptor.variant === "social-single-media" && media.length === 1 && (() => {
        // Exact aspect-ratio from the indexer when available, aspect-square
        // fallback otherwise. Feed cards use object-cover here to avoid
        // visible gray letterboxing inside the slot while scrolling.
        const m = media[0]!;
        const absClass = "absolute inset-0 h-full w-full object-cover";
        return (
          <div
            className="mt-3 relative w-full overflow-hidden bg-accent"
            style={{ aspectRatio: `${m.aspectRatio ?? 1}` }}
          >
            {m.isVideo ? (
              measurementMode ? <div className={cn("absolute inset-0 bg-accent", absClass)} /> : renderFeedVideo(vaultPath, m.sourcePath, absClass)
            ) : (
              !measurementMode && (
                <img
                  src={previewSrc}
                  alt=""
                  className={absClass}
                  loading={imgLoading}
                />
              )
            )}
            {m.isVideoPoster && <PlayBadge />}
          </div>
        );
      })()}
      {descriptor.variant === "social-media-grid" && media.length >= 2 && (
        <div
          className="mt-3 relative w-full overflow-hidden bg-accent"
          style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? 1}` }}
        >
          <GalleryTiles
            items={media}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            fallbackSlug={block.slug}
            measurementMode={measurementMode}
          />
        </div>
      )}

      {block.author && (
        <p className="mt-2 text-sm text-muted-foreground">by {block.author}</p>
      )}
    </div>
  );
});

const ArticleCard = memo(function ArticleCard({
  block,
  descriptor,
  vaultPath,
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  vaultPath: string;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const hasPreview = descriptor.variant === "article-media";
  const primaryMedia = descriptor.mediaItems[0];
  const rendersFeedVideo = hasPreview && descriptor.mediaItems.length === 1 && primaryMedia?.isVideo;

  return (
    <div className="p-4">
      <p
        className="line-clamp-2 text-sm font-semibold text-foreground"
        style={{ lineHeight: "16px" }}
      >
        {block.title ?? block.slug}
      </p>
      {descriptor.previewText && (
        <p
          className={cn(
            "mt-1.5 text-sm text-muted-foreground",
            hasPreview ? "line-clamp-3" : "line-clamp-8",
          )}
          style={{ lineHeight: "20px" }}
        >
          {descriptor.previewText}
        </p>
      )}
      {hasPreview && (
        // Exact aspect-ratio from the indexer's media_dimensions when
        // available (images extracted from body at index time), or
        // aspect-video fallback for older/unreindexed blocks. Multi-image
        // article previews reserve a square gallery slot; single-image
        // previews use object-cover to avoid letterboxing in feed cards.
        <div
          className="relative mt-3 w-full overflow-hidden bg-accent"
          style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? (16 / 9)}` }}
        >
          {descriptor.totalMediaCount > 1 ? (
            <GalleryTiles
              items={descriptor.mediaItems}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath}
              fallbackSlug={block.slug}
              measurementMode={measurementMode}
            />
          ) : rendersFeedVideo ? (
            measurementMode ? (
              <div className="absolute inset-0 bg-accent" />
            ) : (
              renderFeedVideo(vaultPath, primaryMedia.sourcePath, "absolute inset-0 h-full w-full object-cover")
            )
          ) : !measurementMode && (
            <img
              src={thumbnailUrl(thumbsRootPath, block.slug)}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              loading={imgLoading}
            />
          )}
          {rendersFeedVideo && <PlayBadge />}
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
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const thumb = thumbnailUrl(thumbsRootPath, block.slug);
  const mediaSrc = block.media_file ? mediaUrl(vaultPath, block.media_file) : null;
  const playableVideo = block.media_file ? isPlayableVideoSrc(block.media_file) : false;
  const posterSrc = mediaSrc && !playableVideo ? mediaSrc : thumb;

  return (
    <div className="relative aspect-video">
      {!measurementMode && playableVideo && mediaSrc ? (
        <VideoFromBlob
          src={mediaSrc}
          className="h-full w-full object-cover"
          autoPlay
          loop
          muted
        />
      ) : !measurementMode ? (
        <img
          src={posterSrc}
          alt=""
          className="h-full w-full object-cover"
          loading={imgLoading}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="h-full w-full bg-accent" />
      )}
      <PlayBadge />
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
