import { useState, useEffect, useMemo, memo, createContext, useContext, forwardRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ImageOff } from "lucide-react";
import type { IndexedBlock, LightBlock } from "@/types";
import {
  mediaUrl,
  previewAssetUrl,
  thumbnailUrl,
  domainFromUrl,
  isSafeUrl,
  legacyThumbsRoot,
} from "@/lib/assets";
import {
  deriveCardLayoutDescriptor,
  deriveContentCardSlots,
  getRuntimeCardKind,
  parsePreviewManifest,
  type CardLayoutDescriptor,
} from "@/lib/cardLayout";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";
import { CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX } from "@/lib/cardTypography";
import { CARD_HOVER_ACTION_MIN_HEIGHT } from "@/lib/cardHeight";
import { buildFeedVideoPosterCandidates } from "@/lib/feedVideoPoster";
import { getDisplayTitle, getNavigationLabel } from "@/lib/displayTitle";
import { cn } from "@/lib/utils";
import { CardHoverMenu } from "./CardHoverMenu";
import { FeedVideoSurface } from "./FeedVideoSurface";
import { FeedVideoPoster } from "./FeedVideoPoster";

const PriorityContext = createContext(false);
const usePriority = () => useContext(PriorityContext);
const contentCardPreviewTextStyle = {
  lineHeight: `${CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX}px`,
} as const;

interface CardProps {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  priority?: boolean;
  allowPlayback?: boolean;
  openMoreMenuRequestSequence?: number;
  hoverEnabled?: boolean;
  onKeyboardMoreMenuOpenChange?: (open: boolean) => void;
  onClick: (block: LightBlock) => void;
  tags?: import("@/types").TagCount[];
  currentTag?: string;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void;
  onRequestRename?: (block: LightBlock) => void;
  onRequestDelete?: (slug: string) => void;
}

const CARD_FRAME_CLASS =
  "group relative overflow-hidden border border-border rounded-[var(--radius-card)] bg-background";

interface CardFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

interface GraphicSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const CardFrame = forwardRef<HTMLDivElement, CardFrameProps>(function CardFrame(
  { children, className, style, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(CARD_FRAME_CLASS, className)}
      style={{ minHeight: CARD_HOVER_ACTION_MIN_HEIGHT, ...style }}
      {...props}
    >
      {children}
    </div>
  );
});

function GraphicSurface({
  children,
  className,
  ...props
}: GraphicSurfaceProps) {
  return (
    <div
      data-card-graphic-surface=""
      className={cn("relative overflow-hidden bg-accent", className)}
      {...props}
    >
      {children}
    </div>
  );
}

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

export const Card = memo(function Card({ block, vaultPath, thumbsRootPath, priority, allowPlayback = true, openMoreMenuRequestSequence = 0, hoverEnabled = true, onKeyboardMoreMenuOpenChange, onClick, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestRename, onRequestDelete }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: block.slug,
    data: {
      type: "block",
      slug: block.slug,
      block,
    },
  });
  const isArticleFeedCard = getRuntimeCardKind(block) === "article";

  const handleClick = () => onClick(block);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
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
        isArticleFeedCard && "feed-article-card",
        isDragging && "opacity-30",
      )}
    >
      {tags && onToggleTag && onCreateAndAssign && onRequestRename && onRequestDelete && (
        <CardHoverMenu
          block={block}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
          openMoreMenuRequestSequence={openMoreMenuRequestSequence}
          hoverEnabled={hoverEnabled}
          onKeyboardMoreMenuOpenChange={onKeyboardMoreMenuOpenChange}
        />
      )}
      <CardContent block={block} vaultPath={vaultPath} thumbsRootPath={thumbsRootPath} priority={priority} allowPlayback={allowPlayback} />
    </CardFrame>
  );
});

export function ReadOnlyCardPreview({
  block,
  vaultPath,
  thumbsRootPath,
  width = 240,
  previewMode = "full",
}: {
  block: LightBlock & Partial<Pick<IndexedBlock, "thumb_format" | "thumb_mtime">>;
  vaultPath: string;
  thumbsRootPath?: string;
  width?: number;
  previewMode?: "full" | "micro";
}) {
  if (previewMode === "micro") {
    const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);
    const mtime = typeof block.thumb_mtime === "number" && block.thumb_mtime > 0
      ? `?m=${block.thumb_mtime}`
      : "";
    const manifest = parsePreviewManifest(block);
    const firstTile = manifest?.tiles[0] ?? null;
    const previewWidth = firstTile?.width ?? manifest?.width ?? block.width;
    const previewHeight = firstTile?.height ?? manifest?.height ?? block.height;
    const aspectRatio = previewWidth && previewHeight ? previewWidth / previewHeight : 1;
    const title = getDisplayTitle(block) ?? getNavigationLabel(block);
    const previewText = block.preview_text?.trim() ?? "";
    const hasText = Boolean(title || previewText || block.author);
    const isPureTextPreview =
      block.thumb_format === "png" &&
      manifest?.kind === "text" &&
      !block.media_file &&
      !block.thumbnail &&
      !block.first_image &&
      !block.media_urls;

    return (
      <CardFrame
        className="pointer-events-none rounded-1 shadow-lg"
        style={{ width }}
      >
        <div className="p-4">
          {!isPureTextPreview && (
            <GraphicSurface
              className="w-full"
              style={{ aspectRatio }}
            >
              <img
                src={`${thumbnailUrl(resolvedThumbsRoot, block.slug)}${mtime}`}
                alt=""
                className={cn(
                  "absolute inset-0 size-full object-cover",
                  block.thumb_format === "png" && "dark:invert",
                )}
                loading="eager"
                draggable={false}
              />
            </GraphicSurface>
          )}
          {hasText && (
            <div className={cn(!isPureTextPreview && "mt-3")}>
              {title && (
                <p
                  className="line-clamp-2 text-sm font-semibold text-foreground"
                  style={{ lineHeight: "16px" }}
                >
                  {title}
                </p>
              )}
              {previewText && (
                <p
                  className={cn("text-sm text-muted-foreground", title && "mt-1.5", "line-clamp-3")}
                  style={contentCardPreviewTextStyle}
                >
                  {previewText}
                </p>
              )}
              {block.author && (
                <p className={cn("text-sm text-muted-foreground", (title || previewText) && "mt-2")}>
                  by {block.author}
                </p>
              )}
            </div>
          )}
        </div>
      </CardFrame>
    );
  }

  return (
    <CardFrame
      className="pointer-events-none rounded-1 shadow-lg"
      style={{ width }}
    >
      <CardContent
        block={block}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath}
        allowPlayback={false}
      />
    </CardFrame>
  );
}

export function DragCardPreview(props: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  width?: number;
}) {
  return <ReadOnlyCardPreview {...props} />;
}

export function InteractiveCardPreview({
  block,
  vaultPath,
  thumbsRootPath,
  width = 240,
  className,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onInteractiveOpenChange,
  onInteractionStart,
  onClick,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  width?: number;
  className?: string;
  tags: import("@/types").TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
  onInteractiveOpenChange?: (open: boolean) => void;
  onInteractionStart?: () => void;
  onClick?: (block: LightBlock) => void;
}) {
  return (
    <CardFrame
      data-block-slug={block.slug}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn("cursor-pointer rounded-1 shadow-lg", !onClick && "cursor-default", className)}
      style={{ width, borderRadius: "var(--radius-1)" }}
      onClick={() => onClick?.(block)}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick(block);
        }
      }}
    >
      <CardHoverMenu
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        onInteractiveOpenChange={onInteractiveOpenChange}
        onInteractionStart={onInteractionStart}
      />
      <CardContent
        block={block}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath}
        allowPlayback={false}
      />
    </CardFrame>
  );
}

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
  allowPlayback = false,
  measurementMode = false,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  priority?: boolean;
  allowPlayback?: boolean;
  measurementMode?: boolean;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);
  const descriptor = useMemo(() => deriveCardLayoutDescriptor(block), [block]);
  const previewManifest = useMemo(
    () => parsePreviewManifest(block),
    [block],
  );
  const playback = useMemo(
    () => normalizeFeedPlayback(block.feed_playback),
    [block.feed_playback],
  );
  const content = (() => {
    switch (descriptor.variant) {
      case "image":
        return <ImageCard block={block} descriptor={descriptor} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
      case "link":
        return <LinkCard block={block} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} measurementMode={measurementMode} />;
      case "article-text":
      case "article-media":
        return <ArticleCard block={block} descriptor={descriptor} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
      case "social-text":
      case "social-single-media":
      case "social-media-grid":
        return <SocialCard block={block} descriptor={descriptor} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
      case "video":
        return <VideoCard block={block} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
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

function resolveOptionalMediaReference(vaultPath: string, src: string | null): string | null {
  if (!src) return null;
  return isSafeUrl(src) ? src : mediaUrl(vaultPath, src);
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function GalleryTileImage({
  item,
  vaultPath,
  thumbsRootPath,
  fallbackSlug,
  allowSourceFallback,
  loading,
}: {
  item: CardLayoutDescriptor["mediaItems"][number];
  vaultPath: string;
  thumbsRootPath: string;
  fallbackSlug: string;
  allowSourceFallback: boolean;
  loading: "eager" | "lazy";
}) {
  const previewSrc = item.previewPath && !item.isVideo
    ? previewAssetUrl(thumbsRootPath, item.previewPath)
    : null;
  const sourceSrc = allowSourceFallback
    ? resolveFeedMediaSrc(vaultPath, item.sourcePath)
    : null;
  const fallbackSrc = thumbnailUrl(thumbsRootPath, fallbackSlug);
  const [src, setSrc] = useState(previewSrc ?? sourceSrc ?? fallbackSrc);

  useEffect(() => {
    setSrc(previewSrc ?? sourceSrc ?? fallbackSrc);
  }, [fallbackSrc, previewSrc, sourceSrc]);

  return (
    <img
      src={src}
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      loading={loading}
      draggable={false}
      onError={() => {
        if (sourceSrc && src !== sourceSrc) {
          setSrc(sourceSrc);
          return;
        }
        if (src !== fallbackSrc) {
          setSrc(fallbackSrc);
        }
      }}
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

        return (
          <div key={`${item.sourcePath}-${index}`} className="relative overflow-hidden bg-accent" style={tileStyle}>
            {!measurementMode && !item.isVideo && (
              <GalleryTileImage
                item={item}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                fallbackSlug={fallbackSlug}
                allowSourceFallback
                loading={imgLoading}
              />
            )}
            {!measurementMode && item.isVideo && (
              <>
                <GalleryTileImage
                  item={item}
                  vaultPath={vaultPath}
                  thumbsRootPath={thumbsRootPath}
                  fallbackSlug={fallbackSlug}
                  allowSourceFallback={false}
                  loading={imgLoading}
                />
                <PlayBadge />
              </>
            )}
            {!measurementMode && item.isVideoPoster && !item.isVideo && <PlayBadge />}
            {measurementMode && (
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
  previewManifest,
  vaultPath,
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;

  // Preview source cascade, in order:
  // 1. the actual media file in the vault (always present the moment
  //    the .md is indexed — the clipper / native host writes the file
  //    before the block row lands),
  // 2. the cached thumbnail at <thumbs>/<slug>.jpg (may not exist yet
  //    while background thumb-gen is still running),
  // 3. a text fallback card with the title and an "image off" icon.
  //
  // Prior behaviour went straight to (2) and skipped to (3) on any
  // error, so a block that landed faster than its thumb (common after
  // clipper save) flashed the browser's broken-image icon or collapsed
  // into the "image off" card even though its source was already on
  // disk and visible in Finder. The cascade closes that gap without
  // any loader state — the <img> element just walks through the
  // candidate list via onError.
  const sources = useMemo(() => {
    return uniqueUrls([
      resolveOptionalMediaReference(vaultPath, block.media_file),
      previewManifest?.primaryPreviewPath
        ? previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath)
        : null,
      resolveOptionalMediaReference(vaultPath, block.thumbnail),
      thumbnailUrl(thumbsRootPath, block.slug),
    ]);
  }, [
    block.media_file,
    block.slug,
    block.thumbnail,
    previewManifest?.primaryPreviewPath,
    vaultPath,
    thumbsRootPath,
  ]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const sourcesKey = sources.join("|");

  // Reset the cascade when the input set changes (new block, vault
  // switch, iCloud refresh). Intentionally does NOT reset on every
  // re-render — the clipper regression taught us that resetting a
  // loading state during unrelated renders produces visible flicker
  // and, in extreme cases, infinite loaders.
  useEffect(() => {
    setSourceIndex(0);
  }, [sourcesKey]);

  useEffect(() => {
    if (sourceIndex < sources.length) return;
    const handler = () => setSourceIndex(0);
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [sourceIndex, sources.length]);

  const currentSrc = sources[sourceIndex] ?? null;
  const navigationLabel = getNavigationLabel(block);

  if (currentSrc === null) {
    return (
      <div className="flex aspect-square items-center justify-center bg-accent">
        <div className="text-center">
          <ImageOff className="mx-auto size-6 text-muted-foreground/50" />
          <p className="mt-1 text-sm text-foreground">
            {navigationLabel}
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
    <GraphicSurface
      style={{ aspectRatio }}
    >
      {!measurementMode && (
        <img
          // Keyed by src so React remounts the element when we fall
          // through to the next candidate. Without the key the browser
          // would reuse the failed request entry and never re-request.
          key={currentSrc}
          src={currentSrc}
          alt={navigationLabel}
          className="absolute inset-0 h-full w-full object-cover"
          loading={imgLoading}
          draggable={false}
          onError={() => setSourceIndex((i) => i + 1)}
        />
      )}
    </GraphicSurface>
  );
});

const LINK_COLORS = [
  "bg-blue-900", "bg-emerald-900", "bg-violet-900", "bg-amber-900",
  "bg-rose-900", "bg-cyan-900", "bg-indigo-900", "bg-teal-900",
];

const LinkCard = memo(function LinkCard({
  block,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  measurementMode = false,
}: {
  block: LightBlock;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const domain = block.url ? domainFromUrl(block.url) : null;
  const navigationLabel = getNavigationLabel(block);
  const sources = useMemo(
    () => uniqueUrls([
      previewManifest?.primaryPreviewPath
        ? previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath)
        : null,
      resolveOptionalMediaReference(vaultPath, block.thumbnail),
      thumbnailUrl(thumbsRootPath, block.slug),
    ]),
    [block.slug, block.thumbnail, previewManifest?.primaryPreviewPath, thumbsRootPath, vaultPath],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourcesKey = sources.join("|");
  const thumb = sources[sourceIndex] ?? null;
  const thumbError = thumb === null;

  useEffect(() => {
    setThumbLoaded(false);
    setSourceIndex(0);
  }, [sourcesKey]);

  // Retry failed loads when vault data refreshes (e.g. iCloud files downloaded)
  useEffect(() => {
    if (!thumbError) return;
    const handler = () => {
      setThumbLoaded(false);
      setSourceIndex(0);
    };
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [thumbError]);

  // No thumbnail — compact card (title + domain only)
  if (thumbError) {
    return (
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-foreground">
          {navigationLabel}
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
      <GraphicSurface className={cn("aspect-video", bgColor)}>
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
            src={thumb ?? ""}
            alt=""
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity",
              thumbLoaded ? "opacity-100" : "opacity-0",
            )}
            loading={imgLoading}
            draggable={false}
            onLoad={() => setThumbLoaded(true)}
            onError={() => {
              setThumbLoaded(false);
              setSourceIndex((i) => i + 1);
            }}
          />
        )}
      </GraphicSurface>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-foreground">
          {navigationLabel}
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
  previewManifest,
  vaultPath,
  thumbsRootPath,
  playback,
  allowPlayback,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const text = descriptor.previewText;
  const media = descriptor.mediaItems;
  const slots = deriveContentCardSlots(descriptor);
  const hasPreviewText = text.length > 0;
  const hasBottomMeta = slots?.hasBottomMeta ?? false;
  const hasTextStack = hasPreviewText || hasBottomMeta;

  return (
    <div className="p-4">
      {descriptor.variant === "social-single-media" && media.length === 1 && (() => {
        // Exact aspect-ratio from the indexer when available, aspect-square
        // fallback otherwise. Feed cards use object-cover here to avoid
        // visible gray letterboxing inside the slot while scrolling.
        const m = media[0]!;
        const absClass = "absolute inset-0 h-full w-full object-cover";
        const shouldAutoplay =
          m.isVideo && !measurementMode && allowPlayback && playback !== null;
        const posterCandidates = buildFeedVideoPosterCandidates({
          slug: block.slug,
          thumbsRootPath,
          previewManifest,
          playback,
          primaryMedia: m,
        });
        return (
          <GraphicSurface
            className="w-full"
            style={{ aspectRatio: `${m.aspectRatio ?? 1}` }}
          >
            {shouldAutoplay ? (
              <FeedVideoSurface
                playback={playback}
                allowPlayback={allowPlayback}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                posterCandidates={posterCandidates}
                className={absClass}
              />
            ) : (
              !measurementMode && (
                m.isVideo ? (
                  <FeedVideoPoster
                    candidateUrls={posterCandidates}
                    alt=""
                    className={absClass}
                    loading={imgLoading}
                  />
                ) : (
                  <GalleryTileImage
                    item={m}
                    vaultPath={vaultPath}
                    thumbsRootPath={thumbsRootPath}
                    fallbackSlug={block.slug}
                    allowSourceFallback={!m.isVideo}
                    loading={imgLoading}
                  />
                )
              )
            )}
            {measurementMode && (
              <div className={cn("absolute inset-0 bg-accent", absClass)} />
            )}
            {(m.isVideo || m.isVideoPoster) && !shouldAutoplay && <PlayBadge />}
          </GraphicSurface>
        );
      })()}
      {descriptor.variant === "social-media-grid" && media.length >= 2 && (
        <GraphicSurface
          className="w-full"
          style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? 1}` }}
        >
          <GalleryTiles
            items={media}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            fallbackSlug={block.slug}
            measurementMode={measurementMode}
          />
        </GraphicSurface>
      )}

      {hasTextStack && (
        <div className={cn(media.length > 0 && "mt-3")}>
          {text && (
            <p
              className="line-clamp-3 text-sm text-muted-foreground"
              style={contentCardPreviewTextStyle}
            >
              {text}
            </p>
          )}

          {hasBottomMeta && (
            <p className={cn("text-sm text-muted-foreground", hasPreviewText && "mt-2")}>
              by {block.author}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

const ArticleCard = memo(function ArticleCard({
  block,
  descriptor,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  playback,
  allowPlayback,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const hasPreview = descriptor.variant === "article-media";
  const primaryMedia = descriptor.mediaItems[0];
  const rendersFeedVideo = hasPreview && descriptor.mediaItems.length === 1 && primaryMedia?.isVideo;
  const shouldAutoplayVideo =
    rendersFeedVideo && !measurementMode && allowPlayback && playback !== null;
  const posterCandidates = buildFeedVideoPosterCandidates({
    slug: block.slug,
    thumbsRootPath,
    previewManifest,
    playback,
    primaryMedia,
  });
  const displayTitle = getDisplayTitle(block);
  const slots = deriveContentCardSlots(descriptor);
  const hasBottomMeta = slots?.hasBottomMeta ?? false;
  const hasTextStack = Boolean(displayTitle) || descriptor.previewText.length > 0 || hasBottomMeta;

  return (
    <div className="p-4">
      {hasPreview && (
        // Exact aspect-ratio from the indexer's media_dimensions when
        // available (images extracted from body at index time), or
        // aspect-video fallback for older/unreindexed blocks. Multi-image
        // article previews reserve a square gallery slot; single-image
        // previews use object-cover to avoid letterboxing in feed cards.
        <GraphicSurface
          className="w-full"
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
            shouldAutoplayVideo ? (
              <FeedVideoSurface
                playback={playback}
                allowPlayback={allowPlayback}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                posterCandidates={posterCandidates}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : !measurementMode ? (
              <FeedVideoPoster
                candidateUrls={posterCandidates}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                loading={imgLoading}
              />
            ) : (
              <div className="absolute inset-0 bg-accent" />
            )
          ) : !measurementMode && (
            <img
              src={thumbnailUrl(thumbsRootPath, block.slug)}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              loading={imgLoading}
              draggable={false}
            />
          )}
          {rendersFeedVideo && !shouldAutoplayVideo && <PlayBadge />}
        </GraphicSurface>
      )}
      {hasTextStack && (
        <div className={cn(hasPreview && "mt-3")}>
          <p
            className="line-clamp-2 text-sm font-semibold text-foreground"
            style={{ lineHeight: "16px" }}
          >
            {displayTitle}
          </p>
          {descriptor.previewText && (
            <p
              className={cn(
                "text-sm text-muted-foreground",
                hasPreview ? "line-clamp-3" : "line-clamp-8",
                "mt-1.5",
              )}
              style={contentCardPreviewTextStyle}
            >
              {descriptor.previewText}
            </p>
          )}
          {hasBottomMeta && (
            <p
              className={cn(
                "text-sm text-muted-foreground",
                (descriptor.previewText.length > 0 || (displayTitle ?? "").length > 0) && "mt-2",
              )}
              style={{ lineHeight: "16px" }}
            >
              {block.author}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

const VideoCard = memo(function VideoCard({
  block,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  playback,
  allowPlayback,
  measurementMode = false,
}: {
  block: LightBlock;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const shouldAutoplay = !measurementMode && allowPlayback && playback !== null;
  const posterCandidates = uniqueUrls([
    ...buildFeedVideoPosterCandidates({
      slug: block.slug,
      thumbsRootPath,
      previewManifest,
      playback,
    }),
    resolveOptionalMediaReference(vaultPath, block.thumbnail),
  ]);

  return (
    <GraphicSurface className="aspect-video">
      {shouldAutoplay ? (
        <FeedVideoSurface
          playback={playback}
          allowPlayback={allowPlayback}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath}
          posterCandidates={posterCandidates}
          className="h-full w-full object-cover"
        />
      ) : !measurementMode ? (
        <FeedVideoPoster
          candidateUrls={posterCandidates}
          alt=""
          className="h-full w-full object-cover"
          loading={imgLoading}
        />
      ) : (
        <div className="h-full w-full bg-accent" />
      )}
      {!shouldAutoplay && <PlayBadge />}
    </GraphicSurface>
  );
});

const FileCard = memo(function FileCard({ block }: { block: LightBlock }) {
  const ext = block.media_file
    ?.split(".")
    .pop()
    ?.toUpperCase();
  const navigationLabel = getNavigationLabel(block);

  return (
    <div className="flex items-center gap-3 p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-1 bg-accent text-sm font-semibold text-muted-foreground">
        {ext ?? "FILE"}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">
          {navigationLabel}
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
