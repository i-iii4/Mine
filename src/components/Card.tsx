import { useState, useEffect, useLayoutEffect, useMemo, useRef, memo, createContext, useContext, forwardRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { IndexedBlock, LightBlock } from "@/types";
import {
  previewAssetUrl,
  domainFromUrl,
  fallbackThumbsRoot,
} from "@/lib/assets";
import {
  deriveCardLayoutDescriptor,
  deriveContentCardSlots,
  parsePreviewManifest,
  type CardLayoutDescriptor,
  type CardLayoutVariant,
} from "@/lib/cardLayout";
import { FeedShowContext, useFeedDisplay } from "@/lib/feedDisplay";
import { PROVISIONAL_MEDIA_ASPECT } from "@/lib/cardAspect";
import {
  PreviewsPendingContext,
  cardPreviewState,
  type CardPreviewState,
} from "@/lib/cardPreviewState";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";
import {
  CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX,
  CONTENT_CARD_TITLE_CLASSES,
  EDGE_TEXT_SIDE_PX,
  cardTextGap,
  EDGE_VISUAL_GAP_PX,
  edgeTextBottom,
  edgeTextTop,
  halfLeading,
  type CardTextLine,
} from "@/lib/cardTypography";
import { CARD_HOVER_ACTION_MIN_HEIGHT, computeCardHeight } from "@/lib/cardHeight";
import { buildFeedVideoPosterCandidates } from "@/lib/feedVideoPoster";
import { getMediaOwnTitle, getNavigationLabel } from "@/lib/displayTitle";
import { renderSearchHighlightedText, searchExcerptText } from "@/lib/searchHighlight";
import {
  uniqueDragBlocks,
  type BlockDragData,
} from "@/lib/blockDrag";
import { cn } from "@/lib/utils";
import { CardCollectionsRow, CardHoverMenu } from "./CardHoverMenu";
import { EDGE_FADE_WIDTH, createTopFadeMaskStyle } from "@/lib/edgeFade";
import { buttonVariants } from "@/components/ui/button";
import { collectionRefLabel } from "@/lib/collections";
import { CardCollectionsContext, shownCollections, useCollectionOrder } from "@/lib/cardCollections";
import { FeedVideoSurface } from "./FeedVideoSurface";
import { FeedVideoPoster } from "./FeedVideoPoster";
import { PlayBadge } from "./PlayBadge";
import { CloudBadge } from "./CloudBadge";

const PriorityContext = createContext(false);
const usePriority = () => useContext(PriorityContext);
/// What the card's media slots paint when they have no preview to show,
/// resolved once per card in `CardContent` (see `cardPreviewState`).
const PreviewStateContext = createContext<CardPreviewState>("missing");
const usePreviewState = () => useContext(PreviewStateContext);
const contentCardPreviewTextStyle = {
  lineHeight: `${CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX}px`,
} as const;
const contentCardSingleLineTextStyle = {
  lineHeight: "16px",
} as const;
const cardFrameRenderStyle = {
  minHeight: CARD_HOVER_ACTION_MIN_HEIGHT,
  contain: "layout paint style",
  transform: "translateZ(0)",
  backfaceVisibility: "hidden",
} as const;

// Per-slug thumbnail cache-buster. On a `thumb:updated` event the feed bumps a
// per-slug version (App → Grid → Card) so a regenerated poster/thumbnail is
// refetched even when its file bytes were rewritten in place — APFS keeps the
// mtime, and the WebView would otherwise serve the stale image (or a
// previously-failed request) from its in-memory cache. `version <= 0` is the
// steady state and leaves the URL untouched, so an unversioned card renders a
// byte-identical URL to before.
function withThumbVersion(url: string, version: number | undefined): string {
  if (!version || version <= 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}

interface CardProps {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  /** Per-slug cache-buster bumped on `thumb:updated`; see {@link withThumbVersion}. */
  thumbVersion?: number;
  priority?: boolean;
  allowPlayback?: boolean;
  openMoreMenuRequestSequence?: number;
  hoverEnabled?: boolean;
  /// Whether the pointer has arrived on this card: only then do its hover
  /// buttons and lift answer `:hover`. The feed arms the card a settling
  /// pointer reached, never one a sweep crosses (SPEC_CARD_STATES.md, С8.6);
  /// outside the feed a card is always armed.
  hoverArmed?: boolean;
  dragBlocks?: readonly LightBlock[];
  clearSelectionOnDragStart?: () => void;
  onKeyboardMoreMenuOpenChange?: (open: boolean) => void;
  /// Any of the card's menus opened or closed — the overflow menu and Connect
  /// alike. The feed uses this to hold the card in place while a menu is open.
  onMenuOpenChange?: (open: boolean) => void;
  onModifiedClick?: (block: LightBlock, event: ReactMouseEvent<HTMLDivElement>) => boolean;
  onClick: (block: LightBlock) => void;
  tags?: import("@/types").TagCount[];
  currentTag?: string;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void;
  onRequestRename?: (block: LightBlock) => void;
  onRequestDelete?: (slug: string) => void;
}

// The frame's corner is `--card-frame-radius` (the card radius unless a
// frame sets its own); what fills it flush inside its 1px border takes
// `--card-frame-inner-radius`, the corner less the border (global.css).
const CARD_FRAME_CLASS =
  "relative overflow-hidden border border-border rounded-[var(--card-frame-radius,var(--radius-card))] bg-card";
const PREVIEW_RETRY_DELAYS_MS = [250, 1000] as const;

interface CardFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

interface GraphicSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** Layout of the media plane the children are painted in. */
  contentClassName?: string;
  /** The window's fill under the media: it moves with the window on a lift,
   *  so it never shows behind the text that rises past the slot. */
  windowClassName?: string;
  /** Whether the content is still in iCloud: the badge stays put on a lift. */
  contentInCloud?: boolean;
}

const CardFrame = forwardRef<HTMLDivElement, CardFrameProps>(function CardFrame(
  { children, className, style, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-feed-card-frame=""
      className={cn(CARD_FRAME_CLASS, className)}
      style={{ ...cardFrameRenderStyle, ...style }}
      {...props}
    >
      {children}
    </div>
  );
});

/// The fill a media slot shows while its preview is on the way: the feed
/// skeleton's `bg-accent` (`CardSkeleton`), no icon and no words, so the card
/// reads as loading. It lies in the picture's plane, under any image that may
/// still arrive, and covers exactly the box the picture would.
function PreviewPendingFill() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 bg-accent"
      data-card-preview-pending=""
    />
  );
}

/// The pending fill, only while the card's preview is on the way: what a
/// video poster or a post's picture leaves when it has nothing to show. In any
/// other state the slot keeps its own surface, as it always has.
function PendingPreviewFallback() {
  return usePreviewState() === "pending" ? <PreviewPendingFill /> : null;
}

/// An image card whose preview is not built yet (SPEC_CARD_MEDIA_GEOMETRY.md,
/// «Карточка без превью»): the same box `CardSourcelessSurface` fills, the
/// quiet fill instead of the card's name and file. Exported so the
/// design-system showcase draws this state from the product.
export function CardPreviewPendingSurface({
  contentInCloud,
  style,
  geometryPending,
}: {
  contentInCloud?: boolean;
  style?: CSSProperties;
  geometryPending?: boolean;
}) {
  return (
    <GraphicSurface
      className="h-full w-full"
      windowClassName={FILL_WINDOW_CLASS}
      contentInCloud={contentInCloud}
      style={style}
      data-card-preview-geometry={geometryPending ? "pending" : undefined}
    >
      <PreviewPendingFill />
    </GraphicSurface>
  );
}

/// The card's surface when there is no image to paint and none is on the way:
/// the media file is gone, or its preview cannot be read. Exported so the
/// design-system showcase draws this state from the product rather than from a
/// copy of it: a copy is what let the showcase drift out of date unnoticed.
export function CardSourcelessSurface({
  label,
  mediaFile,
  previewUnreadable,
  contentInCloud,
  style,
  geometryPending,
}: {
  label: string;
  mediaFile?: string | null;
  previewUnreadable?: boolean;
  contentInCloud?: boolean;
  style?: CSSProperties;
  geometryPending?: boolean;
}) {
  return (
    <GraphicSurface
      className="h-full w-full"
      windowClassName={FILL_WINDOW_CLASS}
      contentClassName="flex items-center justify-center"
      contentInCloud={contentInCloud}
      style={style}
      data-card-preview-geometry={geometryPending ? "pending" : undefined}
    >
      {/* No icon: a crossed-out picture says nothing the sentence below does
          not, and this is the state where a name is worth more than a symbol —
          it is what the person will look for on disk. */}
      <div className="px-3 text-center">
        <p className="text-sm text-foreground">{label}</p>
        {mediaFile && (
          <p className="mt-1 truncate font-mono text-sm text-muted-foreground" data-card-missing-media="">
            {mediaFile}
          </p>
        )}
        {previewUnreadable && (
          // A damaged cache file, named as such: without its own line this
          // state is indistinguishable from a preview that just is not ready
          // yet. The file it derives from is untouched.
          <p className="mt-1 px-3 text-sm text-muted-foreground" data-card-preview-unreadable="">
            Preview file can’t be read
          </p>
        )}
      </div>
    </GraphicSurface>
  );
}

/// A media slot: the layout box, the window the media shows through, and the
/// plane it is painted on. On a card lift (SPEC_CARD_STATES.md, С8) the window
/// rises with the text under it, keeping its own corners, while the plane
/// drifts back half that distance: the box's top edge holds still, the window
/// shrinks from the bottom and the picture inside moves up by half the lift.
/// The box clips the rest, so the outer geometry never changes.
/// A media window that fills its card keeps the card's bottom corners: on a
/// lift its bottom edge rises above the action row and stays rounded, as the
/// media over the text does edge to edge (SPEC_CARD_STATES.md, С8.3). At rest
/// it lies flush inside the frame's border, so its corner is the frame's inner
/// one: a larger corner left a crescent of the card's surface showing.
const FILL_WINDOW_CLASS = "rounded-b-[var(--card-frame-inner-radius)]";

function GraphicSurface({
  children,
  className,
  contentClassName,
  windowClassName,
  contentInCloud,
  ...props
}: GraphicSurfaceProps) {
  return (
    <div
      data-card-graphic-surface=""
      // No fill of its own: the slot stays put on a lift while its window
      // rises, and a fill here would show behind the risen text as a panel
      // with the slot's corners (С8.3).
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <div
        data-card-lift="window"
        className={cn("absolute inset-0 overflow-hidden rounded-[inherit] bg-card", windowClassName)}
      >
        <div data-card-lift="plane" className={cn("absolute inset-0", contentClassName)}>
          {children}
        </div>
      </div>
      <CloudBadge active={contentInCloud} />
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

/// A post card's surface: the dark-theme card background belongs to posts,
/// including a picture `Cards` shows as a post, and not to bare media.
function isPostVariant(variant: CardLayoutVariant): boolean {
  return variant.startsWith("article") || variant.startsWith("social");
}

export const Card = memo(function Card({ block, vaultPath, thumbsRootPath, thumbVersion, priority, allowPlayback = true, openMoreMenuRequestSequence = 0, hoverEnabled = true, hoverArmed = true, dragBlocks: dragBlocksProp, clearSelectionOnDragStart, onKeyboardMoreMenuOpenChange, onMenuOpenChange, onModifiedClick, onClick, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestRename, onRequestDelete }: CardProps) {
  const dragBlocks = useMemo(() => {
    const candidateBlocks = dragBlocksProp && dragBlocksProp.length > 0
      ? dragBlocksProp
      : [block];
    const uniqueBlocks = uniqueDragBlocks(candidateBlocks);
    return uniqueBlocks.length > 0 ? uniqueBlocks : [block];
  }, [block, dragBlocksProp]);
  const dragSlugs = useMemo(
    () => dragBlocks.map((item) => item.slug),
    [dragBlocks],
  );
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: block.slug,
    data: {
      type: "block",
      slug: block.slug,
      block,
      dragSlugs,
      dragBlocks,
      clearSelectionOnDragStart,
    } satisfies BlockDragData,
  });
  const show = useContext(FeedShowContext);
  const descriptor = useMemo(
    () => deriveCardLayoutDescriptor(block, show),
    [block, show],
  );
  // Every card with hover actions lifts to bring its row of collections up
  // from under the bottom edge (С8); bare media lifts its caption with it
  // (С8.7).
  const lifts = Boolean(tags && onToggleTag && onCreateAndAssign && onRequestRename && onRequestDelete);
  const [actionsPinned, setActionsPinned] = useState(false);

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (onModifiedClick?.(block, event)) {
      return;
    }
    onClick(block);
  };
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
      data-feed-card-drag-count={dragSlugs.length > 1 ? String(dragSlugs.length) : undefined}
      data-feed-card-drag-slugs={dragSlugs.length > 1 ? dragSlugs.join(" ") : undefined}
      {...attributes}
      {...listeners}
      role="button"
      // The card's own name in every presentation: `Media` clears the title
      // and text, pictures carry an empty alt, and the hover menu is always in
      // the tree, so without it a screen reader names the card only by its
      // actions (Г4.7).
      aria-label={getNavigationLabel(block)}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // The lift follows the bottom action row exactly: pointer hover while
      // hover is enabled, or a pointer-opened menu holding the row (С8).
      data-card-lift-hover={lifts && hoverEnabled && hoverArmed ? "" : undefined}
      data-card-lift-pinned={lifts && actionsPinned ? "" : undefined}
      style={lifts ? cardLiftStyle(descriptor) : undefined}
      className={cn(
        "h-full",
        // `group` scopes the hover buttons' `group-hover`: an unarmed card is
        // no group, so a sweep shows no buttons on it.
        hoverArmed && "group",
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
          // Only a card that actually plays video needs its controls lifted
          // into layers of their own.
          videoUnderneath={allowPlayback && block.feed_playback !== null}
          onKeyboardMoreMenuOpenChange={onKeyboardMoreMenuOpenChange}
          onInteractiveOpenChange={onMenuOpenChange}
          onActionsPinnedChange={setActionsPinned}
        />
      )}
      <CardContent block={block} vaultPath={vaultPath} thumbsRootPath={thumbsRootPath} thumbVersion={thumbVersion} priority={priority} allowPlayback={allowPlayback} />
      {lifts && <CardLiftCaption block={block} descriptor={descriptor} />}
    </CardFrame>
  );
});

/// How far a lifting card rises, as the `--card-lift` its frame carries
/// (С8.1): by its own bottom space, or, for bare media, by its caption, which
/// sets the property itself (`MediaLiftCaption`).
function cardLiftStyle(descriptor: CardLayoutDescriptor): CSSProperties | undefined {
  return isBareMediaVariant(descriptor.variant) ? undefined : collectionsRowLiftStyle(descriptor);
}

/// Bare media in any presentation (a picture or a video without a frame, or
/// anything `Media` shows as media alone) says what it is when it lifts
/// (С8.7); every other card brings up its row alone.
function CardLiftCaption({ block, descriptor }: { block: LightBlock; descriptor: CardLayoutDescriptor }) {
  return isBareMediaVariant(descriptor.variant) ? <MediaLiftCaption block={block} /> : null;
}

/// The row of collections sits 8px above the bottom edge and is 24px
/// tall (its plus is an `xs` button); its 12px text is centred in it, so the
/// letters stand 14px above the edge, the edge-to-edge gap (Д25). From the
/// edge to the gap above the row's letters is this reach: 8 + 24 − 6 + 14.
const COLLECTIONS_ROW_REACH_PX = 8 + 24 - 6 + EDGE_VISUAL_GAP_PX;

/// How far a card rises so the gap from its last line to the
/// row's letters is the same 14px: the reach less the card's own space under
/// its last letters at rest.
function collectionsRowLiftStyle(descriptor: CardLayoutDescriptor): CSSProperties {
  const hasText = Boolean(descriptor.titleText || descriptor.previewText || descriptor.authorText);
  const ownSpace = (() => {
    switch (descriptor.variant) {
      case "image":
      case "video":
      case "media-only":
        return 0;
      case "link":
        // The footer's p-3 under its last 16px line.
        return 12 + halfLeading("title");
      case "file":
        return 16 + halfLeading("title");
      default:
        return hasText ? EDGE_VISUAL_GAP_PX : 0;
    }
  })();
  // `--card-lift`: the CSS custom property the lift rules in global.css read.
  return { "--card-lift": `${COLLECTIONS_ROW_REACH_PX - ownSpace}px` } as CSSProperties;
}


/// A card that shows media with no frame and no text of its own: a picture or
/// a video in `Mixed`, and every media card in `Media`.
function isBareMediaVariant(variant: CardLayoutVariant): boolean {
  return variant === "image" || variant === "video" || variant === "media-only";
}

/// `Media` shows a card's media alone. A lift reveals what the card says
/// under it, rising with the action row: a picture's or a video's name in
/// muted text, or a post's title, text and author, clamped shorter than in
/// `Cards` (title and author one line, text two) so the media keeps the card
/// (SPEC_CARD_STATES.md, С8.7). The lift is as tall as this caption, so its
/// height is handed to the frame as `--card-lift`; it never takes more than
/// 60% of the card, and text past that is cut. Under the caption it keeps
/// room for the row of collections: the caption's own bottom padding already
/// reads as the gap above the row; with no caption the gap from the media's
/// edge comes on top.
function MediaLiftCaption({ block }: { block: LightBlock }) {
  const panelRef = useRef<HTMLDivElement>(null);
  // `Media` clears a card's text from its descriptor; the caption says what
  // the same card says in `Mixed`.
  const descriptor = useMemo(() => deriveCardLayoutDescriptor(block, "mixed"), [block]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const frame = panel?.closest<HTMLElement>("[data-feed-card-frame]");
    if (!panel || !frame) return;
    const apply = () => frame.style.setProperty("--card-lift", `${panel.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") {
      return () => frame.style.removeProperty("--card-lift");
    }
    const observer = new ResizeObserver(apply);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      frame.style.removeProperty("--card-lift");
    };
  }, []);

  const isPost = isPostVariant(descriptor.variant) || Boolean(descriptor.previewText || descriptor.authorText);
  // A picture or a video names itself only by a title of its own, the body's
  // first heading: never its file's name, nor a legacy `frontmatter.title`
  // the clipper once wrote (SPEC_DISPLAY_TITLE.md, UX Contract, 5).
  const mediaCard = descriptor.variant === "image" || descriptor.variant === "video";
  const title = mediaCard ? (getMediaOwnTitle(block) ?? "") : descriptor.titleText;
  const lines: CardTextLine[] = [];
  if (title) lines.push("title");
  if (isPost && descriptor.previewText) lines.push("preview");
  if (isPost && descriptor.authorText) lines.push("author");
  if (shownCollections(block).length > 0) lines.push("pills");
  const first = lines[0];
  const last = lines[lines.length - 1];
  const gapBefore = textGapsFor(lines);

  return (
    <div
      ref={panelRef}
      data-card-lift="caption"
      className="absolute inset-x-0 bottom-0 flex max-h-[60%] flex-col justify-end overflow-hidden"
    >
      {first && last && (
        <div
          // Never shrinks: past the 60% cap the panel clips its top, so the last
          // line, its gap and the row under it keep their places.
          className="shrink-0"
          style={{ paddingInline: EDGE_TEXT_SIDE_PX, paddingTop: edgeTextTop(first), paddingBottom: edgeTextBottom(last) }}
        >
          {title && (
            <p
              className={cn("truncate", isPost ? CONTENT_CARD_TITLE_CLASSES : "text-sm text-muted-foreground")}
              style={contentCardSingleLineTextStyle}
            >
              {title}
            </p>
          )}
          {isPost && descriptor.previewText && (
            <p
              className="line-clamp-2 text-sm text-muted-foreground"
              style={{ ...contentCardPreviewTextStyle, marginTop: gapBefore("preview") }}
            >
              {descriptor.previewText}
            </p>
          )}
          {isPost && descriptor.authorText && (
            <p
              className="truncate text-sm text-muted-foreground"
              style={{ ...contentCardSingleLineTextStyle, marginTop: gapBefore("author") }}
            >
              {descriptor.authorText}
            </p>
          )}
          <CardCollectionPills collections={shownCollections(block)} style={{ marginTop: gapBefore("pills") }} />
        </div>
      )}
      <div
        className="shrink-0"
        style={{ height: first ? COLLECTIONS_ROW_REACH_PX - EDGE_VISUAL_GAP_PX : COLLECTIONS_ROW_REACH_PX }}
      />
    </div>
  );
}

type CardShadow = "none" | "sm" | "md" | "lg";

const CARD_SHADOW_CLASS: Record<CardShadow, string | null> = {
  none: null,
  sm: "shadow-sm",
  md: "shadow-md",
  lg: "shadow-lg",
};

/// A card drawn outside the feed is the feed's own card: the presentation the
/// feed shows now (`Show`), the same title rule, media geometry, surface and
/// corner (SPEC_CARD_STATES.md, С10). Nothing in it can be pressed. `raised`
/// stands it in the feed card's final hover state at once (С8): its content
/// lifted, a bare media card's caption up, its collections at the bottom as
/// text, and no Source, More or Connect. A dragged card stays at rest, as the
/// feed card does under a drag (С8.5).
function StaticCard({
  block,
  vaultPath,
  thumbsRootPath,
  width,
  shadow,
  thumbVersion,
  raised,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  width: number;
  shadow: CardShadow;
  thumbVersion?: number;
  raised: boolean;
}) {
  const { show } = useFeedDisplay();
  const descriptor = useMemo(() => deriveCardLayoutDescriptor(block, show), [block, show]);
  // Bare media fills the box the feed reserves for it at this width; a framed
  // card takes its content's own height, the one the feed reserves for it
  // (SPEC_FEED_DISPLAY.md, Д15).
  const reservedHeight = isBareMediaVariant(descriptor.variant)
    ? computeCardHeight(block, width, null, show)
    : undefined;

  return (
    <FeedShowContext.Provider value={show}>
      <CardFrame
        data-card-preview=""
        data-card-lift-pinned={raised ? "" : undefined}
        className={cn(
          "pointer-events-none",
          CARD_SHADOW_CLASS[shadow],
        )}
        style={{ width, height: reservedHeight, ...(raised ? cardLiftStyle(descriptor) : undefined) }}
      >
        <CardContent
          block={block}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath}
          allowPlayback={false}
          thumbVersion={thumbVersion}
          priority={true}
        />
        {raised && <CardLiftCaption block={block} descriptor={descriptor} />}
        {raised && <RaisedCollectionsRow collections={block.collections} />}
      </CardFrame>
    </FeedShowContext.Provider>
  );
}

/// The row of collections a raised card shows where the feed card's row
/// stands after its lift (С8.9): the same names in the sidebar's order, as
/// text, with no Connect plus. It keeps the row's 24px, which the lift counts
/// (С8.1).
function RaisedCollectionsRow({ collections }: { collections: readonly string[] }) {
  const order = useCollectionOrder();
  return (
    <div
      className="absolute bottom-2 left-2 right-2 z-[5] flex h-6 items-center"
      data-card-preview-collections=""
    >
      <CardCollectionsRow collections={collections} order={order} readOnly />
    </div>
  );
}

/// A card shown on hover (graph, sidebar, related notes) or as the search
/// result's preview: the feed card in its final hover state (С10). A preview
/// floating over the window carries a shadow; one standing in a pane of its
/// own does not.
export function ReadOnlyCardPreview({
  block: sourceBlock,
  vaultPath,
  thumbsRootPath,
  width = 240,
  shadow = "lg",
  thumbVersion,
}: {
  block: LightBlock | IndexedBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  width?: number;
  shadow?: "none" | "lg";
  thumbVersion?: number;
}) {
  const block: LightBlock =
    "related_notes" in sourceBlock
      // A full block names its collections as `tags`.
      ? { ...sourceBlock, search_match: null, collections: sourceBlock.tags }
      : sourceBlock;
  return (
    <StaticCard
      block={block}
      vaultPath={vaultPath}
      thumbsRootPath={thumbsRootPath}
      width={width}
      shadow={shadow}
      thumbVersion={thumbVersion}
      raised
    />
  );
}

export function DragCardPreview({
  block,
  vaultPath,
  thumbsRootPath,
  width = 240,
  shadow = "lg",
  thumbVersion,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  width?: number;
  shadow?: "sm" | "md" | "lg";
  thumbVersion?: number;
}) {
  return (
    <StaticCard
      block={block}
      vaultPath={vaultPath}
      thumbsRootPath={thumbsRootPath}
      width={width}
      shadow={shadow}
      thumbVersion={thumbVersion}
      raised={false}
    />
  );
}

const DRAG_STACK_LAYERS = [
  { index: 0, x: 0, y: 0, rotate: 0, shadow: "lg" },
  { index: 1, x: -6, y: -6, rotate: -0.9, shadow: "md" },
  { index: 2, x: 7, y: -11, rotate: 0.75, shadow: "sm" },
  { index: 3, x: -2, y: -16, rotate: -0.45, shadow: "sm" },
] as const;

function DragStackCardPreview({
  block,
  vaultPath,
  thumbsRootPath,
  width,
  shadow,
  thumbVersion,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  width: number;
  shadow: "sm" | "md" | "lg";
  thumbVersion?: number;
}) {
  return (
    <div data-feed-drag-stack-card="">
      <DragCardPreview
        block={block}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath}
        width={width}
        shadow={shadow}
        thumbVersion={thumbVersion}
      />
    </div>
  );
}

export function DragCardStackPreview({
  blocks,
  vaultPath,
  thumbsRootPath,
  width = 240,
  thumbVersions,
}: {
  blocks: readonly LightBlock[];
  vaultPath: string;
  thumbsRootPath?: string;
  width?: number;
  thumbVersions?: ReadonlyMap<string, number>;
}) {
  const visibleBlocks = blocks.slice(0, DRAG_STACK_LAYERS.length);
  const visibleCount = visibleBlocks.length;
  const frontBlock = blocks[0];
  if (!frontBlock) return null;
  if (visibleCount === 1) {
    return (
      <DragCardPreview
        block={frontBlock}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath}
        width={width}
        thumbVersion={thumbVersions?.get(frontBlock.slug)}
      />
    );
  }

  const visibleLayers = visibleBlocks
    .map((block, index) => ({
      block,
      layer: DRAG_STACK_LAYERS[index] ?? DRAG_STACK_LAYERS[0],
    }))
    .reverse();

  return (
    <div
      className="pointer-events-none relative"
      style={{ width }}
      data-feed-drag-stack=""
      data-feed-drag-stack-count={String(blocks.length)}
      data-feed-drag-stack-visible-count={String(visibleCount)}
    >
      {visibleLayers.map(({ block, layer }) => (
        <div
          key={block.slug}
          className={cn(layer.index === 0 ? "relative" : "absolute inset-0")}
          style={{
            zIndex: DRAG_STACK_LAYERS.length - layer.index,
            transform:
              layer.index === 0
                ? undefined
                : `translate3d(${layer.x}px, ${layer.y}px, 0) rotate(${layer.rotate}deg)`,
            transformOrigin: "center center",
          }}
          data-feed-drag-stack-layer=""
          data-feed-drag-stack-layer-index={String(layer.index)}
          data-feed-drag-stack-front={layer.index === 0 ? "" : undefined}
        >
          <DragStackCardPreview
            block={block}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            width={width}
            shadow={layer.shadow}
            thumbVersion={thumbVersions?.get(block.slug)}
          />
        </div>
      ))}
      {blocks.length > visibleCount && (
        <div
          className="absolute -right-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full border border-background bg-foreground px-1.5 font-mono text-[11px] leading-none text-background shadow-sm"
          data-feed-drag-stack-count-badge=""
        >
          {blocks.length}
        </div>
      )}
    </div>
  );
}

export const CardSkeleton = memo(function CardSkeleton({
  block,
}: {
  block: LightBlock;
}) {
  const show = useContext(FeedShowContext);
  const descriptor = useMemo(() => deriveCardLayoutDescriptor(block, show), [block, show]);
  const hasMedia =
    descriptor.variant === "media-only" ||
    descriptor.variant === "image" ||
    descriptor.variant === "video" ||
    (descriptor.variant === "link" && descriptor.primaryAspectRatio !== null) ||
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
            style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
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
  thumbVersion,
  priority,
  allowPlayback = false,
  measurementMode = false,
}: {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  thumbVersion?: number;
  priority?: boolean;
  allowPlayback?: boolean;
  measurementMode?: boolean;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);
  const show = useContext(FeedShowContext);
  const descriptor = useMemo(
    () => deriveCardLayoutDescriptor(block, show),
    [block, show],
  );
  const previewManifest = useMemo(
    () => parsePreviewManifest(block),
    [block],
  );
  const playback = useMemo(
    () => normalizeFeedPlayback(block.feed_playback),
    [block.feed_playback],
  );
  const previewsPending = useContext(PreviewsPendingContext);
  const previewState = cardPreviewState(block, previewsPending);
  const content = (() => {
    switch (descriptor.variant) {
      case "image":
        return <ImageCard block={block} descriptor={descriptor} previewManifest={previewManifest} thumbsRootPath={resolvedThumbsRoot} thumbVersion={thumbVersion} measurementMode={measurementMode} />;
      case "link":
        return <LinkCard block={block} reservesThumbnail={descriptor.primaryAspectRatio !== null} previewManifest={previewManifest} thumbsRootPath={resolvedThumbsRoot} thumbVersion={thumbVersion} measurementMode={measurementMode} />;
      case "article-text":
      case "article-media":
        return <ArticleCard block={block} descriptor={descriptor} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} thumbVersion={thumbVersion} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
      case "social-text":
      case "social-single-media":
      case "social-media-grid":
        return <SocialCard block={block} descriptor={descriptor} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} thumbVersion={thumbVersion} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
      case "video":
        return <VideoCard aspectRatio={descriptor.primaryAspectRatio} contentInCloud={block.content_in_cloud} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} thumbVersion={thumbVersion} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
      case "file":
        return <FileCard block={block} />;
      case "media-only":
        return <PostMediaSurface fit="fill" block={block} descriptor={descriptor} previewManifest={previewManifest} vaultPath={vaultPath} thumbsRootPath={resolvedThumbsRoot} thumbVersion={thumbVersion} playback={playback} allowPlayback={allowPlayback} measurementMode={measurementMode} />;
    }
  })();
  return (
    <PriorityContext.Provider value={!!priority}>
      <PreviewStateContext.Provider value={previewState}>
        {content}
      </PreviewStateContext.Provider>
    </PriorityContext.Provider>
  );
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
  thumbsRootPath,
  thumbVersion,
  loading,
}: {
  item: CardLayoutDescriptor["mediaItems"][number];
  thumbsRootPath: string;
  thumbVersion?: number;
  loading: "eager" | "lazy";
}) {
  const [failed, setFailed] = useState(false);
  const previewState = usePreviewState();
  const previewSrc = item.previewPath
    ? withThumbVersion(previewAssetUrl(thumbsRootPath, item.previewPath), thumbVersion)
    : null;

  useEffect(() => {
    setFailed(false);
  }, [previewSrc]);

  if (!previewSrc || failed) {
    return previewState === "pending"
      ? <PreviewPendingFill />
      : <div className="absolute inset-0 bg-card" data-preview-unavailable="" />;
  }

  return (
    <img
      src={previewSrc}
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      loading={loading}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function GalleryTiles({
  items,
  thumbsRootPath,
  thumbVersion,
  measurementMode,
}: {
  items: CardLayoutDescriptor["mediaItems"];
  thumbsRootPath: string;
  thumbVersion?: number;
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
    <div className="absolute inset-0 grid gap-px bg-card" style={gridStyle}>
      {visibleItems.map((item, index) => {
        const tileStyle = count === 3 && index === 0 ? { gridRow: "1 / span 2" } : undefined;

        return (
          <div
            key={`${item.sourcePath}-${index}`}
            className="relative overflow-hidden bg-card"
            style={tileStyle}
            data-card-media-tile=""
          >
            {!measurementMode && !item.isVideo && (
              <GalleryTileImage
                item={item}
                thumbsRootPath={thumbsRootPath}
                thumbVersion={thumbVersion}
                loading={imgLoading}
              />
            )}
            {!measurementMode && item.isVideo && (
              <>
                <GalleryTileImage
                  item={item}
                  thumbsRootPath={thumbsRootPath}
                  thumbVersion={thumbVersion}
                  loading={imgLoading}
                />
                <PlayBadge />
              </>
            )}
            {!measurementMode && item.isVideoPoster && !item.isVideo && <PlayBadge />}
            {measurementMode && (
              <div className="absolute inset-0 bg-card" />
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
  thumbsRootPath,
  thumbVersion,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  thumbsRootPath: string;
  thumbVersion?: number;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const previewState = usePreviewState();
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => { setRetryCount(0); }, [previewManifest?.primaryPreviewPath, thumbVersion]);

  const sources = useMemo(() => {
    return uniqueUrls([
      previewManifest?.primaryPreviewPath
        ? withThumbVersion(previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath), thumbVersion)
        : null,
    ]);
  }, [
    previewManifest?.primaryPreviewPath,
    thumbsRootPath,
    thumbVersion,
  ]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const sourcesKey = sources.join("|");

  // Retry transient cache misses twice, using a fresh URL. Never loop forever
  // on a genuinely missing asset, and cancel retries when the card unmounts.
  useEffect(() => {
    const delay = PREVIEW_RETRY_DELAYS_MS[retryCount];
    if (sourceIndex < sources.length || sources.length === 0 || delay === undefined) return;
    const timer = window.setTimeout(() => {
      setRetryCount((count) => count + 1);
      setSourceIndex(0);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [sourceIndex, sources.length, retryCount]);

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

  const source = sources[sourceIndex] ?? null;
  const currentSrc = source && retryCount > 0
    ? `${source}${source.includes("?") ? "&" : "?"}retry=${retryCount}` : source;
  const navigationLabel = getNavigationLabel(block);
  // A null ratio means the preview artifact does not exist yet, which is a
  // state of its own rather than a shape. Claiming a square here would state a
  // proportion the card does not know and crop the image to it; instead the
  // surface fills the provisional envelope the layout reserved, and the one
  // `thumb:updated` that follows re-lays the card with real geometry.
  // See SPEC_CARD_MEDIA_GEOMETRY.md.
  const geometryPending = descriptor.primaryAspectRatio === null;
  const surfaceStyle = geometryPending
    ? undefined
    : { aspectRatio: `${descriptor.primaryAspectRatio}` };

  if (currentSrc === null) {
    // A preview on the way is a fill, not a card that names its file: during
    // a space's first preview pass every picture is here, and a file name on
    // each reads as breakage. The name and file stay for a preview that is
    // not coming (SPEC_CARD_MEDIA_GEOMETRY.md, «Карточка без превью»).
    return previewState === "pending" ? (
      <CardPreviewPendingSurface
        contentInCloud={block.content_in_cloud}
        style={surfaceStyle}
        geometryPending={geometryPending}
      />
    ) : (
      <CardSourcelessSurface
        label={navigationLabel}
        mediaFile={block.media_file}
        previewUnreadable={previewState === "unreadable"}
        contentInCloud={block.content_in_cloud}
        style={surfaceStyle}
        geometryPending={geometryPending}
      />
    );
  }

  // The ratio comes from the artifact this card paints, and the layout reserved
  // its height from that same number, so the surface fits its slot exactly.
  //
  // Width is claimed explicitly all the same. With height alone, `aspect-ratio`
  // derives the width from whatever height the layout hands down, so any
  // residual disagreement — a clamped height, a stale committed row — would
  // shrink the graphic away from the card edge instead of being absorbed by
  // `object-cover` on the axis the layout owns.
  return (
    <GraphicSurface
      className="h-full w-full"
      windowClassName={FILL_WINDOW_CLASS}
      style={surfaceStyle}
      data-card-preview-geometry={geometryPending ? "pending" : undefined}
      contentInCloud={block.content_in_cloud}
    >
      {!measurementMode && (
        <img
          // Keyed by src so React remounts the element when we fall through to
          // the next candidate. Without the key the browser would reuse the
          // failed request entry and never re-request.
          key={currentSrc}
          src={currentSrc}
          alt={navigationLabel}
          className="absolute inset-0 h-full w-full object-cover"
          loading={imgLoading}
          decoding="async"
          draggable={false}
          onError={() => {
            setSourceIndex((i) => i + 1);
          }}
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
  reservesThumbnail,
  previewManifest,
  thumbsRootPath,
  thumbVersion,
  measurementMode = false,
}: {
  block: LightBlock;
  /** The layout reserved the page picture's slot above the text. */
  reservesThumbnail: boolean;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  thumbsRootPath: string;
  thumbVersion?: number;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const previewState = usePreviewState();
  // The picture that has loaded, not a flag: a reset in an effect ran after
  // the load of a picture already in the cache had fired (a preview loads at
  // once what the feed has just shown) and left the page picture hidden for
  // good. A new source is simply not the loaded one.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const domain = block.url ? domainFromUrl(block.url) : null;
  const navigationLabel = getNavigationLabel(block);
  const sources = useMemo(
    () => uniqueUrls([
      previewManifest?.primaryPreviewPath
        ? withThumbVersion(previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath), thumbVersion)
        : null,
    ]),
    [previewManifest?.primaryPreviewPath, thumbsRootPath, thumbVersion],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourcesKey = sources.join("|");
  const thumb = sources[sourceIndex] ?? null;
  const thumbError = thumb === null;
  const thumbLoaded = thumb !== null && loadedSrc === thumb;

  useEffect(() => {
    setSourceIndex(0);
  }, [sourcesKey]);

  // Retry failed loads when vault data refreshes (e.g. iCloud files downloaded)
  useEffect(() => {
    if (!thumbError) return;
    const handler = () => {
      setLoadedSrc(null);
      setSourceIndex(0);
    };
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [thumbError]);

  const textFooter = (
    <div className="p-3" data-card-lift="text">
      <p className={cn("truncate", CONTENT_CARD_TITLE_CLASSES)} style={contentCardSingleLineTextStyle}>
        {navigationLabel}
      </p>
      {domain && (
        <p className="mt-0.5 truncate text-sm text-muted-foreground" style={contentCardSingleLineTextStyle}>{domain}</p>
      )}
      <CardCollectionPills collections={shownCollections(block)} style={{ marginTop: 8 }} />
    </div>
  );

  // No thumbnail. While the page picture is on the way, the slot the layout
  // reserved for it holds the quiet fill above the text; otherwise the card
  // is compact, title and domain only.
  if (thumbError) {
    if (previewState !== "pending" || !reservesThumbnail) {
      return textFooter;
    }
    return (
      <div className="flex flex-col">
        <GraphicSurface className="aspect-video">
          <PreviewPendingFill />
        </GraphicSurface>
        {textFooter}
      </div>
    );
  }

  const initial = (domain ?? block.slug).charAt(0).toUpperCase();
  const colorIdx = block.slug.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const bgColor = LINK_COLORS[colorIdx % LINK_COLORS.length]!;

  return (
    <div className="flex flex-col">
      <GraphicSurface className="aspect-video" windowClassName={bgColor}>
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
            decoding="async"
            draggable={false}
            onLoad={() => setLoadedSrc(thumb)}
            onError={() => {
              setLoadedSrc(null);
              setSourceIndex((i) => i + 1);
            }}
          />
        )}
      </GraphicSurface>
      {textFooter}
    </div>
  );
});

const SocialCard = memo(function SocialCard({
  block,
  descriptor,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  thumbVersion,
  playback,
  allowPlayback,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  thumbVersion?: number;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const previewSearchMatch =
    block.search_match?.field === "description" || block.search_match?.field === "body" || block.search_match?.field === "semantic"
      ? block.search_match
      : null;
  const text = searchExcerptText(previewSearchMatch, descriptor.previewText);
  const media = descriptor.mediaItems;
  const slots = deriveContentCardSlots(descriptor);
  const hasPreviewText = text.length > 0;
  const hasBottomMeta = slots?.hasBottomMeta ?? false;
  const hasTextStack = hasPreviewText || hasBottomMeta || shownCollections(block).length > 0;

  const mediaSurface = descriptor.variant === "social-single-media" && media.length === 1 ? (() => {
    // Shape comes from the descriptor: the artifact this slot paints,
    // clamped into the card range, the same number the height was reserved
    // from (Г4.5). When it has not been measured the slot takes the
    // provisional envelope and says so in the markup, the same state an
    // image card uses — a square here would be a proportion nobody knows.
    // Feed cards use object-cover to avoid visible letterboxing inside the
    // slot while scrolling.
    const m = media[0]!;
    const aspectRatio = descriptor.primaryAspectRatio;
    const absClass = "absolute inset-0 h-full w-full object-cover";
    const shouldAutoplay =
      m.isVideo && !measurementMode && allowPlayback && playback !== null;
    const posterCandidates = buildFeedVideoPosterCandidates({
      thumbsRootPath,
      previewManifest,
      playback,
      primaryMedia: m,
    }).map((url) => withThumbVersion(url, thumbVersion));
    return (
      <GraphicSurface
        className="w-full rounded-b-[var(--radius-card)]"
        style={{ aspectRatio: `${aspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
        data-card-preview-geometry={aspectRatio === null ? "pending" : undefined}
        contentInCloud={block.content_in_cloud}
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
                fallback={<PendingPreviewFallback />}
              />
            ) : (
              <GalleryTileImage
                item={m}
                thumbsRootPath={thumbsRootPath}
                thumbVersion={thumbVersion}
                loading={imgLoading}
              />
            )
          )
        )}
        {measurementMode && (
          <div className={cn("absolute inset-0 bg-card", absClass)} />
        )}
        {(m.isVideo || m.isVideoPoster) && !shouldAutoplay && <PlayBadge />}
      </GraphicSurface>
    );
  })() : descriptor.variant === "social-media-grid" && media.length >= 2 ? (
    // The tile grid across the frame's width; the seams between tiles stay
    // straight (Д21).
    <GraphicSurface
      className="w-full rounded-b-[var(--radius-card)]"
      style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
      contentInCloud={block.content_in_cloud}
    >
      <GalleryTiles
        items={media}
        thumbsRootPath={thumbsRootPath}
        thumbVersion={thumbVersion}
        measurementMode={measurementMode}
      />
    </GraphicSurface>
  ) : null;

  const lines: CardTextLine[] = [];
  if (text) lines.push("preview");
  if (hasBottomMeta) lines.push("author");
  if (shownCollections(block).length > 0) lines.push("pills");
  const gapBefore = textGapsFor(lines);

  return (
    <PostCardBody
      media={mediaSurface}
      textLines={lines}
      textStack={hasTextStack ? (
        <>
          {text && (
            <p
              className="line-clamp-3 text-sm text-muted-foreground"
              style={contentCardPreviewTextStyle}
            >
              {renderSearchHighlightedText(text, previewSearchMatch)}
            </p>
          )}

          {hasBottomMeta && (
            // One line, as the height reserves it: a longer name ends in an
            // ellipsis instead of wrapping under the frame's edge (Г4.6).
            <p
              className="truncate text-sm text-muted-foreground"
              style={{ ...contentCardSingleLineTextStyle, marginTop: gapBefore("author") }}
            >
              by {block.author}
            </p>
          )}
          <CardCollectionPills collections={shownCollections(block)} style={{ marginTop: gapBefore("pills") }} />
        </>
      ) : null}
    />
  );
});

/// A card's collections as one row of pills under its text, in the sidebar's
/// order (SPEC_CARD_STATES.md, С9). The open collection's pill is marked;
/// pressing a pill opens its collection, as the sidebar row does, and never
/// the card. One row only, so the reserved height is fixed: pills past the
/// card's width fade out at its edge.
function CardCollectionPills({ collections, style }: { collections: readonly string[]; style?: CSSProperties }) {
  const navigation = useContext(CardCollectionsContext);
  if (collections.length === 0) return null;
  return (
    <div
      data-card-collections=""
      className="flex h-6 gap-1 overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
      style={style}
    >
      {collections.map((tag) => {
        const current = navigation?.currentTag === tag;
        return (
          <button
            key={tag}
            type="button"
            data-card-collection-pill={tag}
            data-card-collection-current={current ? "" : undefined}
            className={cn(
              buttonVariants({ variant: "reference", size: "xs" }),
              // A pill that opens its collection: the reference body with the
              // line colour round it, since it can be pressed.
              "h-6 shrink-0 font-mono font-normal",
              current ? "text-foreground outline-[var(--border-accent)]" : "text-muted-foreground outline-border",
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              navigation?.open(tag);
            }}
          >
            {collectionRefLabel(tag)}
          </button>
        );
      })}
    </div>
  );
}

/// The top-edge fade a rising text post dissolves into (global.css slides it
/// into place with the lift).
const TOP_LIFT_FADE_MASK_STYLE = createTopFadeMaskStyle(EDGE_FADE_WIDTH);

/// The box gap above each line of a text stack: none above the first line,
/// the typography's gap between neighbours otherwise. `computeCardHeight`
/// counts the same gaps (cardHeight.ts, `cardTextStackHeight`).
function textGapsFor(lines: readonly CardTextLine[]) {
  return (line: CardTextLine): number => {
    const index = lines.indexOf(line);
    const above = index > 0 ? lines[index - 1] : undefined;
    return above ? cardTextGap(above, line) : 0;
  };
}

/// The body of a framed card with its media on top and its text under it:
/// posts, articles, X and Instagram posts, and pictures `Cards` frames as
/// posts. The media spans the frame's inner width from its top edge, with no
/// outline of its own; the frame's clip gives it the card's top corners and
/// its bottom corners take the card radius where the text starts. The text
/// under it is padded 8px at its sides, and every vertical gap reads 14px
/// from letter to letter: the boxes are spaced by the gap less the
/// half-leading of the lines that meet (SPEC_FEED_DISPLAY.md, Д20, Д25). Media
/// with no text under it is the whole body. `postCardHeight` in cardHeight.ts
/// reserves exactly this.
function PostCardBody({
  media,
  textLines,
  textStack,
}: {
  /** The media surface, or null for a card without media. */
  media: ReactNode;
  /** The lines the text stack paints, top to bottom. */
  textLines: readonly CardTextLine[];
  /** The text under the media, or null when there is none. */
  textStack: ReactNode;
}) {
  const hasMedia = media !== null;
  const first = textLines[0];
  const last = textLines[textLines.length - 1];
  const body = (
    <div>
      {media}
      {textStack !== null && first && last && (
        <div
          data-card-lift="text"
          style={{
            paddingInline: EDGE_TEXT_SIDE_PX,
            paddingTop: edgeTextTop(first),
            paddingBottom: edgeTextBottom(last),
          }}
        >
          {textStack}
        </div>
      )}
    </div>
  );
  // A text post's body rises past the top edge on a lift; it dissolves there
  // with the sidebar strip's fade curve.
  return !hasMedia
    ? <div data-card-lift-fade="" style={TOP_LIFT_FADE_MASK_STYLE}>{body}</div>
    : body;
}

/// How a post's media surface sits in its card: `edge` across the frame's
/// inner width with no outline of its own, the frame's clip rounding its top
/// corners (SPEC_FEED_DISPLAY.md, Д20); `fill` the whole card, in `Media`
/// (Д13).
type PostMediaFit = "edge" | "fill";

/// A post's media: one picture, one video, or the gallery, placed as `fit`
/// says. In `Media` the post shows its media and nothing else (Д13).
function PostMediaSurface({
  fit,
  block,
  descriptor,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  thumbVersion,
  playback,
  allowPlayback,
  measurementMode,
}: {
  fit: PostMediaFit;
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  thumbVersion?: number;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const previewState = usePreviewState();
  const primaryMedia = descriptor.mediaItems[0];
  const rendersFeedVideo = descriptor.mediaItems.length === 1 && primaryMedia?.isVideo;
  const shouldAutoplayVideo =
    rendersFeedVideo && !measurementMode && allowPlayback && playback !== null;
  const posterCandidates = buildFeedVideoPosterCandidates({
    thumbsRootPath,
    previewManifest,
    playback,
    primaryMedia,
  }).map((url) => withThumbVersion(url, thumbVersion));

  return (
    // Exact aspect-ratio from the preview artifact; the provisional envelope
    // while it is not made yet. Multi-image previews reserve a gallery slot;
    // single images use object-cover to avoid letterboxing in feed cards.
    // Edge to edge: the frame rounds the media's top corners; its bottom
    // corners take the same card radius where the text starts (SPEC_FEED_DISPLAY.md, Д20).
    <GraphicSurface
      className={cn(fit === "fill" ? "h-full w-full" : "w-full", fit === "edge" && "rounded-b-[var(--radius-card)]")}
      windowClassName={fit === "fill" ? FILL_WINDOW_CLASS : undefined}
      style={{ aspectRatio: `${descriptor.primaryAspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
      data-card-preview-geometry={descriptor.primaryAspectRatio === null ? "pending" : undefined}
      contentInCloud={block.content_in_cloud}
    >
      {descriptor.totalMediaCount > 1 ? (
        <GalleryTiles
          items={descriptor.mediaItems}
          thumbsRootPath={thumbsRootPath}
          thumbVersion={thumbVersion}
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
            fallback={<PendingPreviewFallback />}
          />
        ) : (
          <div className="absolute inset-0 bg-card" />
        )
      ) : !measurementMode && (
        // Grid never falls through to source media. A ready manifest owns
        // the derived tile. Without one (a picture `Cards` frames before its
        // preview is built, or an inconsistent descriptor until
        // reconciliation repairs the preview set) the slot is the pending
        // fill while the preview is on the way and a neutral surface otherwise.
        primaryMedia ? (
          <GalleryTileImage
            item={primaryMedia}
            thumbsRootPath={thumbsRootPath}
            thumbVersion={thumbVersion}
            loading={imgLoading}
          />
        ) : previewState === "pending" ? (
          <PreviewPendingFill />
        ) : (
          <div className="absolute inset-0 bg-card" data-preview-unavailable="" />
        )
      )}
      {rendersFeedVideo && !shouldAutoplayVideo && <PlayBadge />}
    </GraphicSurface>
  );
}

const ArticleCard = memo(function ArticleCard({
  block,
  descriptor,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  thumbVersion,
  playback,
  allowPlayback,
  measurementMode = false,
}: {
  block: LightBlock;
  descriptor: CardLayoutDescriptor;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  thumbVersion?: number;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode?: boolean;
}) {
  const hasPreview = descriptor.variant === "article-media";
  // The descriptor's title: the post's own, or a picture's file name when
  // `Cards` shows it as a post (SPEC_FEED_DISPLAY.md, Д12).
  const displayTitle = descriptor.titleText || null;
  const titleSearchMatch = block.search_match?.field === "title" ? block.search_match : null;
  const previewSearchMatch =
    block.search_match?.field === "description" || block.search_match?.field === "body" || block.search_match?.field === "semantic"
      ? block.search_match
      : null;
  const previewText = searchExcerptText(previewSearchMatch, descriptor.previewText);
  const slots = deriveContentCardSlots(descriptor);
  const hasBottomMeta = slots?.hasBottomMeta ?? false;
  const hasTextStack = Boolean(displayTitle) || previewText.length > 0 || hasBottomMeta
    || shownCollections(block).length > 0;
  // The lines this card paints, in order: an absent title takes no line and
  // no gap with it, exactly as the reserved height counts it.
  const lines: CardTextLine[] = [];
  if (displayTitle) lines.push("title");
  if (previewText) lines.push("preview");
  if (hasBottomMeta) lines.push("author");
  if (shownCollections(block).length > 0) lines.push("pills");
  const gapBefore = textGapsFor(lines);

  return (
    <PostCardBody
      textLines={lines}
      media={hasPreview ? (
        <PostMediaSurface
          fit="edge"
          block={block}
          descriptor={descriptor}
          previewManifest={previewManifest}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath}
          thumbVersion={thumbVersion}
          playback={playback}
          allowPlayback={allowPlayback}
          measurementMode={measurementMode}
        />
      ) : null}
      textStack={hasTextStack ? (
        <>
          {displayTitle && (
            <p
              className={cn("line-clamp-2", CONTENT_CARD_TITLE_CLASSES)}
              style={contentCardSingleLineTextStyle}
            >
              {renderSearchHighlightedText(displayTitle, titleSearchMatch)}
            </p>
          )}
          {previewText && (
            <p
              className={cn(
                "text-sm text-muted-foreground",
                hasPreview ? "line-clamp-3" : "line-clamp-8",
              )}
              style={{ ...contentCardPreviewTextStyle, marginTop: gapBefore("preview") }}
            >
              {renderSearchHighlightedText(previewText, previewSearchMatch)}
            </p>
          )}
          {hasBottomMeta && (
            // One line, as the height reserves it: a longer name ends in an
            // ellipsis instead of wrapping under the frame's edge (Г4.6).
            <p
              className="truncate text-sm text-muted-foreground"
              style={{ ...contentCardSingleLineTextStyle, marginTop: gapBefore("author") }}
            >
              {block.author}
            </p>
          )}
          <CardCollectionPills collections={shownCollections(block)} style={{ marginTop: gapBefore("pills") }} />
        </>
      ) : null}
    />
  );
});

const VideoCard = memo(function VideoCard({
  aspectRatio,
  contentInCloud,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  thumbVersion,
  playback,
  allowPlayback,
  measurementMode = false,
}: {
  /** The poster's shape; null until the poster is made. */
  aspectRatio: number | null;
  contentInCloud: boolean | undefined;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  thumbVersion?: number;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode?: boolean;
}) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const shouldAutoplay = !measurementMode && allowPlayback && playback !== null;
  const posterCandidates = uniqueUrls([
    ...buildFeedVideoPosterCandidates({
      thumbsRootPath,
      previewManifest,
      playback,
    }).map((url) => withThumbVersion(url, thumbVersion)),
  ]);

  return (
    // The poster's shape, like a post's media: the height the grid reserved
    // is computed from the same ratio (SPEC_CARD_MEDIA_GEOMETRY.md).
    <GraphicSurface
      style={{ aspectRatio: `${aspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
      windowClassName={FILL_WINDOW_CLASS}
      data-card-preview-geometry={aspectRatio === null ? "pending" : undefined}
      contentInCloud={contentInCloud}
    >
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
          fallback={<PendingPreviewFallback />}
        />
      ) : (
        <div className="h-full w-full bg-card" />
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
    <div className="flex items-center gap-3 p-4" data-card-lift="text">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-1 bg-accent text-sm font-semibold text-muted-foreground">
        {ext ?? "FILE"}
      </div>
      <div className="min-w-0">
        <p className={cn("truncate", CONTENT_CARD_TITLE_CLASSES)} style={contentCardSingleLineTextStyle}>
          {navigationLabel}
        </p>
        {block.media_file && (
          <p className="truncate text-sm text-muted-foreground" style={contentCardSingleLineTextStyle}>
            {block.media_file}
          </p>
        )}
      </div>
    </div>
  );
});
