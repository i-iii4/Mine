import { useState, useEffect, useLayoutEffect, useMemo, useRef, memo, createContext, useContext, forwardRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { IndexedBlock, LightBlock } from "@/types";
import {
  previewAssetUrl,
  fallbackThumbsRoot,
} from "@/lib/assets";
import {
  deriveCardLayoutDescriptor,
  hasCardText,
  parsePreviewManifest,
  type CardLayoutDescriptor,
  type CardLayoutMedia,
  type CardLayoutMediaItem,
  type CardLayoutText,
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
  type CardTextLine,
} from "@/lib/cardTypography";
import { CARD_HOVER_ACTION_MIN_HEIGHT, computeCardHeight } from "@/lib/cardHeight";
import { buildFeedVideoPosterCandidates } from "@/lib/feedVideoPoster";
import { getNavigationLabel } from "@/lib/displayTitle";
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

// The frame (SPEC_FEED_DISPLAY.md, Д20; DESIGN_SYSTEM.md, «Линия рамки поверх
// содержимого»). Its 1px line is drawn over everything the frame holds
// (`::after`, global.css), and what it holds is clipped at the line's middle:
// the clip sits half a pixel in from the frame's edge with the corner less
// half a pixel, and the content half a pixel further in, so the content box
// is the one a 1px border left. Every edge of the content then lies under
// the line, which is opaque and pixel-snapped: wherever the engine puts a
// picture's edge, the line hides it, and the line's own edges are smoothed
// against the page outside and against the content inside, never against a
// gap. The corner is `--card-frame-radius` (the card radius unless a frame
// sets its own).
const CARD_FRAME_CLASS = "relative p-[0.5px] rounded-[var(--card-frame-outer-radius)]";
const CARD_FRAME_CLIP_CLASS =
  "relative isolate h-full overflow-hidden p-[0.5px] rounded-[var(--card-frame-line-radius)] bg-card";
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
  /** Media that ends its card: on a lift it rises over what comes up under
   *  it, and its outline rises with it (SPEC_FEED_DISPLAY.md, Д20). At rest
   *  that outline lies on the frame's own line. Media with text under it
   *  takes its outline from the text part instead (`FramedCardBody`). */
  liftOutline?: boolean;
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
      <div data-card-frame-clip="" className={CARD_FRAME_CLIP_CLASS}>
        <div data-card-frame-content="" className="relative h-full">
          {children}
        </div>
      </div>
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
      liftOutline
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
      liftOutline
      contentClassName="flex items-center justify-center"
      contentInCloud={contentInCloud}
      style={style}
      data-card-preview-geometry={geometryPending ? "pending" : undefined}
    >
      <SourcelessMessage label={label} mediaFile={mediaFile} previewUnreadable={previewUnreadable} />
    </GraphicSurface>
  );
}

/// What a media slot says when its media is not there and not coming: the
/// file is gone, or its preview cannot be read (SPEC_CARD_UNIFIED.md, Е7).
function SourcelessMessage({
  label,
  mediaFile,
  previewUnreadable,
}: {
  label: string;
  mediaFile?: string | null;
  previewUnreadable?: boolean;
}) {
  return (
    // No icon: a crossed-out picture says nothing the sentence below does
    // not, and this is the state where a name is worth more than a symbol:
    // it is what the person will look for on disk.
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
  );
}

/// A media slot: the layout box, the clip the media shows through, the window
/// inside it and the plane the media is painted on. The layout box is the
/// media's visible box, the one the feed reserves. The clip is that box grown
/// by half a pixel on every side, with the corner of the line's middle: every
/// media slot in a frame is bordered by a line drawn over it, the frame's on
/// its top and sides and the frame's or the media's outline at its bottom
/// (SPEC_FEED_DISPLAY.md, Д20), so the media's edge always lies under a line
/// and its visible corner is the line's inner one, at the bottom as at the
/// top. On a card lift (SPEC_CARD_STATES.md, С8) the window rises with the
/// text under it, keeping its corners, while the plane drifts back half that
/// distance: the clip's top edge holds still, the window shrinks from the
/// bottom and the picture inside moves up by half the lift. The clip cuts the
/// rest, so the outer geometry never changes.
function GraphicSurface({
  children,
  className,
  contentClassName,
  windowClassName,
  contentInCloud,
  liftOutline,
  ...props
}: GraphicSurfaceProps) {
  return (
    <div
      data-card-graphic-surface=""
      // No fill of its own: the slot stays put on a lift while its window
      // rises, and a fill here would show behind the risen text as a panel
      // with the slot's corners (С8.3).
      className={cn("relative", className)}
      {...props}
    >
      <div
        data-card-media-clip=""
        className="absolute -inset-[0.5px] overflow-hidden rounded-[var(--card-frame-line-radius)]"
      >
        <div
          data-card-lift="window"
          className={cn("absolute inset-0 overflow-hidden rounded-[inherit] bg-card", windowClassName)}
        >
          <div data-card-lift="plane" className={cn("absolute inset-0", contentClassName)}>
            {children}
          </div>
        </div>
        {/* Over the window: at rest it lies on the frame's own line, on a
            lift it rises with the window (global.css). */}
        {liftOutline && <span aria-hidden="true" data-card-media-outline="on-lift" />}
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
      style={lifts ? cardLiftStyle(block, descriptor) : undefined}
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

/// Whether the card shows a text part: its text, or the pills under it (С9),
/// in the presentation that keeps them in the card.
function hasTextPart(block: LightBlock, descriptor: CardLayoutDescriptor): boolean {
  return descriptor.textShown === "always"
    && (hasCardText(descriptor.text) || shownCollections(block).length > 0);
}

/// Whether the lift brings up a caption: the presentation keeps the card's
/// text for it (`Media`), and the card has text (SPEC_CARD_UNIFIED.md, Е12).
function hasLiftCaption(descriptor: CardLayoutDescriptor): boolean {
  return descriptor.textShown === "on-lift" && hasCardText(descriptor.text);
}

/// How far a lifting card rises, as the `--card-lift` its frame carries
/// (С8.1): by the room under its last letters, the same rule for every card,
/// or by its caption, which sets the property itself (`MediaLiftCaption`).
function cardLiftStyle(block: LightBlock, descriptor: CardLayoutDescriptor): CSSProperties | undefined {
  return hasLiftCaption(descriptor)
    ? undefined
    : collectionsRowLiftStyle(hasTextPart(block, descriptor));
}

/// A card whose text the presentation keeps for the lift says it there
/// (С8.7); every other card brings up its row alone (Е12).
function CardLiftCaption({ block, descriptor }: { block: LightBlock; descriptor: CardLayoutDescriptor }) {
  return hasLiftCaption(descriptor) ? <MediaLiftCaption block={block} text={descriptor.text} /> : null;
}

/// The row of collections sits 8px above the bottom edge and is 24px
/// tall (its plus is an `xs` button); its 12px text is centred in it, so the
/// letters stand 14px above the edge, the edge-to-edge gap (Д25). From the
/// edge to the gap above the row's letters is this reach: 8 + 24 − 6 + 14.
const COLLECTIONS_ROW_REACH_PX = 8 + 24 - 6 + EDGE_VISUAL_GAP_PX;

/// How far a card rises so the gap from its last line to the row's letters is
/// the same 14px: the reach less the card's own room under its last letters at
/// rest, which is that same gap under a text part (Д25) and nothing under
/// media that fills the card or under an empty card (SPEC_CARD_UNIFIED.md, Е12).
function collectionsRowLiftStyle(textPart: boolean): CSSProperties {
  const ownSpace = textPart ? EDGE_VISUAL_GAP_PX : 0;
  // `--card-lift`: the CSS custom property the lift rules in global.css read.
  return { "--card-lift": `${COLLECTIONS_ROW_REACH_PX - ownSpace}px` } as CSSProperties;
}

/// `Media` shows a card's media alone. A lift reveals the card's own text
/// under it, rising with the action row: its title, text and author, clamped
/// shorter than in `Cards` (title and author one line, text two) so the media
/// keeps the card (SPEC_CARD_STATES.md, С8.7). Nothing is put in place of a
/// text the card does not have (SPEC_CARD_UNIFIED.md, Е12). The lift is as
/// tall as this caption, so its height is handed to the frame as
/// `--card-lift`; it never takes more than 60% of the card, and text past
/// that is cut. Under the caption it keeps room for the row of collections:
/// the caption's own bottom padding already reads as the gap above the row.
function MediaLiftCaption({ block, text }: { block: LightBlock; text: CardLayoutText }) {
  const panelRef = useRef<HTMLDivElement>(null);
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

  const lines: CardTextLine[] = [];
  if (text.title) lines.push("title");
  if (text.text) lines.push("preview");
  if (text.author) lines.push("author");
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
          {text.title && (
            <p className={cn("truncate", CONTENT_CARD_TITLE_CLASSES)} style={contentCardSingleLineTextStyle}>
              {text.title}
            </p>
          )}
          {text.text && (
            <p
              className="line-clamp-2 text-sm text-muted-foreground"
              style={{ ...contentCardPreviewTextStyle, marginTop: gapBefore("preview") }}
            >
              {text.text}
            </p>
          )}
          {text.author && (
            <p
              className="truncate text-sm text-muted-foreground"
              style={{ ...contentCardSingleLineTextStyle, marginTop: gapBefore("author") }}
            >
              {text.author}
            </p>
          )}
          <CardCollectionPills collections={shownCollections(block)} style={{ marginTop: gapBefore("pills") }} />
        </div>
      )}
      <div className="shrink-0" style={{ height: COLLECTIONS_ROW_REACH_PX - EDGE_VISUAL_GAP_PX }} />
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
  // Media that fills its card takes the box the feed reserves for it at this
  // width; any other card takes its content's own height, the one the feed
  // reserves for it (SPEC_FEED_DISPLAY.md, Д15).
  const reservedHeight = descriptor.media !== null && !descriptor.textUnderMedia
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
        style={{ width, height: reservedHeight, ...(raised ? cardLiftStyle(block, descriptor) : undefined) }}
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
  const textShown = descriptor.textShown === "always";

  return (
    <MeasuredCardFrame className="h-full">
      <div className="flex h-full flex-col p-4">
        <div className="h-4 w-2/3 rounded-[2px] bg-accent" />
        {textShown && descriptor.text.text && (
          <>
            <div className="mt-2 h-3 w-full rounded-[2px] bg-accent" />
            <div className="mt-1.5 h-3 w-5/6 rounded-[2px] bg-accent" />
          </>
        )}
        {descriptor.media && (
          <div
            className="mt-3 w-full rounded-[2px] bg-accent"
            style={{ aspectRatio: `${descriptor.media.aspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
          />
        )}
        {textShown && descriptor.text.author && (
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
  return (
    <PriorityContext.Provider value={!!priority}>
      <PreviewStateContext.Provider value={previewState}>
        <CardBody
          block={block}
          descriptor={descriptor}
          previewManifest={previewManifest}
          vaultPath={vaultPath}
          thumbsRootPath={resolvedThumbsRoot}
          thumbVersion={thumbVersion}
          playback={playback}
          allowPlayback={allowPlayback}
          measurementMode={measurementMode}
        />
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

/// What a media slot needs to paint its media, whatever the media is.
interface CardMediaProps {
  block: LightBlock;
  previewManifest: ReturnType<typeof parsePreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  thumbVersion?: number;
  playback: ReturnType<typeof normalizeFeedPlayback>;
  allowPlayback: boolean;
  measurementMode: boolean;
}

/// The body of every card (SPEC_CARD_UNIFIED.md, Е5, Е8): the shown media on
/// top, across the frame's inner width, and the text part under it. Either
/// part may be absent: media with no text part under it fills the card, text
/// without media is the whole body, and a card without content is the frame
/// alone, with nothing put in its place. No part of it depends on the kind of
/// record the content comes from.
const CardBody = memo(function CardBody({
  descriptor,
  ...mediaProps
}: CardMediaProps & { descriptor: CardLayoutDescriptor }) {
  const { block } = mediaProps;
  if (descriptor.mode === "empty") return null;
  const { media } = descriptor;
  const text = descriptor.textShown === "always" ? descriptor.text : null;
  const titleSearchMatch = block.search_match?.field === "title" ? block.search_match : null;
  const textSearchMatch =
    block.search_match?.field === "description" || block.search_match?.field === "body" || block.search_match?.field === "semantic"
      ? block.search_match
      : null;
  const title = text?.title ?? "";
  const shownText = text ? searchExcerptText(textSearchMatch, text.text) : "";
  const author = text?.author ?? "";
  const collections = text ? shownCollections(block) : [];

  // The lines this card paints, in order: an absent part takes no line and no
  // gap with it, exactly as the reserved height counts it (cardHeight.ts).
  const lines: CardTextLine[] = [];
  if (title) lines.push("title");
  if (shownText) lines.push("preview");
  if (author) lines.push("author");
  if (collections.length > 0) lines.push("pills");
  const gapBefore = textGapsFor(lines);

  const mediaSlot = media ? (
    <CardMediaSlot media={media} fills={!descriptor.textUnderMedia} {...mediaProps} />
  ) : null;
  if (mediaSlot && lines.length === 0) return mediaSlot;

  return (
    <PostCardBody
      media={mediaSlot}
      textUnderMedia={descriptor.textUnderMedia}
      textLines={lines}
      textStack={lines.length > 0 ? (
        <>
          {title && (
            <p
              className={cn("line-clamp-2", CONTENT_CARD_TITLE_CLASSES)}
              style={contentCardSingleLineTextStyle}
            >
              {renderSearchHighlightedText(title, titleSearchMatch)}
            </p>
          )}
          {shownText && (
            <p
              className={cn("text-sm text-muted-foreground", media ? "line-clamp-3" : "line-clamp-8")}
              style={{ ...contentCardPreviewTextStyle, marginTop: gapBefore("preview") }}
            >
              {renderSearchHighlightedText(shownText, textSearchMatch)}
            </p>
          )}
          {author && (
            // One line, as the height reserves it: a longer name ends in an
            // ellipsis instead of wrapping under the frame's edge (Г4.6).
            <p
              className="truncate text-sm text-muted-foreground"
              style={{ ...contentCardSingleLineTextStyle, marginTop: gapBefore("author") }}
            >
              {author}
            </p>
          )}
          <CardCollectionPills collections={collections} style={{ marginTop: gapBefore("pills") }} />
        </>
      ) : null}
    />
  );
});

/// A card's media slot (SPEC_CARD_UNIFIED.md, Е5, Е7). Its shape is the
/// painted artifact's, the provisional envelope while that is not measured
/// (SPEC_CARD_MEDIA_GEOMETRY.md), and the layout reserved its height from the
/// same number. Media with no text part under it fills the card, the box the
/// layout reserved, and the shape only shapes it where no box is given
/// (measurement). Width is claimed explicitly all the same: with height alone,
/// `aspect-ratio` would derive the width from whatever height the layout hands
/// down and shrink the media away from the card's edge.
function CardMediaSlot({
  media,
  fills,
  ...props
}: CardMediaProps & { media: CardLayoutMedia; fills: boolean }) {
  const { block } = props;
  return (
    <GraphicSurface
      className={fills ? "h-full w-full" : "w-full"}
      contentClassName="flex items-center justify-center"
      liftOutline={fills}
      style={{ aspectRatio: `${media.aspectRatio ?? PROVISIONAL_MEDIA_ASPECT}` }}
      data-card-preview-geometry={media.aspectRatio === null ? "pending" : undefined}
      contentInCloud={block.content_in_cloud}
    >
      <CardMediaPaint media={media} {...props} />
    </GraphicSurface>
  );
}

/// What the slot paints, by what the media is: a picture from the card's
/// whole preview, a picture from its own tile, a video, or a gallery.
function CardMediaPaint({ media, ...props }: CardMediaProps & { media: CardLayoutMedia }) {
  const paint = media.paint;
  switch (paint.kind) {
    case "gallery":
      return (
        <GalleryTiles
          items={media.items}
          thumbsRootPath={props.thumbsRootPath}
          thumbVersion={props.thumbVersion}
          measurementMode={props.measurementMode}
        />
      );
    case "video":
      return <VideoMedia media={media} {...props} />;
    case "preview":
      return <PreviewPicture {...props} />;
    case "tile":
      return <TilePicture item={paint.item} {...props} />;
  }
}

/// One video: playing when the feed lets it, its poster otherwise
/// (SPEC_FEED_VIDEO.md).
function VideoMedia({
  media,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  thumbVersion,
  playback,
  allowPlayback,
  measurementMode,
}: CardMediaProps & { media: CardLayoutMedia }) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const shouldAutoplay = !measurementMode && allowPlayback && playback !== null;
  const posterCandidates = buildFeedVideoPosterCandidates({
    thumbsRootPath,
    previewManifest,
    playback,
    primaryMedia: media.items[0],
  }).map((url) => withThumbVersion(url, thumbVersion));

  if (measurementMode) return <div className="absolute inset-0 bg-card" />;
  return (
    <>
      {shouldAutoplay ? (
        <FeedVideoSurface
          playback={playback}
          allowPlayback={allowPlayback}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath}
          posterCandidates={posterCandidates}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <FeedVideoPoster
          candidateUrls={posterCandidates}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading={imgLoading}
          fallback={<PendingPreviewFallback />}
        />
      )}
      {!shouldAutoplay && <PlayBadge />}
    </>
  );
}

/// One picture from the card's whole preview: a picture card, a link's page
/// picture. A preview on the way is the quiet fill; a preview that is not
/// coming says so in the slot (Е7).
function PreviewPicture({
  block,
  previewManifest,
  thumbsRootPath,
  thumbVersion,
  measurementMode,
}: CardMediaProps) {
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

  if (measurementMode) return null;
  if (currentSrc === null) {
    // A preview on the way is a fill, not a card that names its file: during
    // a space's first preview pass every picture is here, and a file name on
    // each reads as breakage. The name and file stay for a preview that is
    // not coming (SPEC_CARD_MEDIA_GEOMETRY.md, «Карточка без превью»).
    return previewState === "pending" ? (
      <PreviewPendingFill />
    ) : (
      <SourcelessMessage
        label={getNavigationLabel(block)}
        mediaFile={block.media_file}
        previewUnreadable={previewState === "unreadable"}
      />
    );
  }
  return (
    <img
      // Keyed by src so React remounts the element when we fall through to
      // the next candidate. Without the key the browser would reuse the
      // failed request entry and never re-request.
      key={currentSrc}
      src={currentSrc}
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      loading={imgLoading}
      decoding="async"
      draggable={false}
      onError={() => {
        setSourceIndex((i) => i + 1);
      }}
    />
  );
}

/// One picture from its own tile: a post's picture paints its tile, never the
/// card's whole preview, which may be built from another file
/// (SPEC_CARD_MEDIA_GEOMETRY.md). Without a tile the slot is the pending fill
/// while the preview is on the way and a neutral surface otherwise.
function TilePicture({
  item,
  thumbsRootPath,
  thumbVersion,
  measurementMode,
}: CardMediaProps & { item: CardLayoutMediaItem | null }) {
  const imgLoading = usePriority() ? "eager" as const : "lazy" as const;
  const previewState = usePreviewState();
  if (measurementMode) return null;
  if (!item) {
    return previewState === "pending"
      ? <PreviewPendingFill />
      : <div className="absolute inset-0 bg-card" data-preview-unavailable="" />;
  }
  return (
    <>
      <GalleryTileImage
        item={item}
        thumbsRootPath={thumbsRootPath}
        thumbVersion={thumbVersion}
        loading={imgLoading}
      />
      {item.isVideoPoster && <PlayBadge />}
    </>
  );
}

function GalleryTileImage({
  item,
  thumbsRootPath,
  thumbVersion,
  loading,
}: {
  item: CardLayoutMediaItem;
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
  items: CardLayoutMediaItem[];
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
    // Tiles meet edge to edge, no seam between them (user's decision of
    // 07.10.2026): the gallery reads as one picture inside the card's frame.
    <div className="absolute inset-0 grid bg-card" style={gridStyle}>
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

/// The body of every framed card that may stack text under media: posts,
/// articles, X and Instagram posts, pictures `Cards` frames as posts, and
/// links. Its media, when it has one, comes first; its text part follows and
/// rises with the lift (SPEC_CARD_STATES.md, С8.2, С8.3). When the card's
/// descriptor stands text under the media (`textUnderMedia`), the text part
/// opens with the media's outline (SPEC_FEED_DISPLAY.md, Д20): outside the
/// media, hugging its bottom edge and rounded corners, so at the media's
/// sides it lies on the frame's own side lines and under the media it is the
/// line above the text. An overlay: the card's height does not change.
function FramedCardBody({
  media,
  textUnderMedia,
  text,
  textClassName,
  textStyle,
}: {
  /** The media surface, or null for a card without media. */
  media: ReactNode;
  /** The descriptor's `textUnderMedia`: the text part opens with the
   *  media's outline. */
  textUnderMedia: boolean;
  /** The text part's content, or null when the card has none. */
  text: ReactNode;
  /** The text part's own padding. */
  textClassName?: string;
  textStyle?: CSSProperties;
}) {
  return (
    <div>
      {media}
      {text !== null && (
        <div data-card-lift="text" className={cn("relative", textClassName)} style={textStyle}>
          {textUnderMedia && media !== null && (
            <span aria-hidden="true" data-card-media-outline="under-text" />
          )}
          {text}
        </div>
      )}
    </div>
  );
}

/// The body of a framed card with its media on top and its text under it:
/// posts, articles, X and Instagram posts, and pictures `Cards` frames as
/// posts. The media spans the frame's inner width from its top edge; the
/// frame's line gives it its top corners and the media's outline, which opens
/// the text part, gives it the same corners at the bottom (Д20). The text is padded 8px at its sides,
/// and every vertical gap reads 14px from letter to letter: the boxes are
/// spaced by the gap less the half-leading of the lines that meet
/// (SPEC_FEED_DISPLAY.md, Д20, Д25). Media with no text under it is the whole
/// body. `postCardHeight` in cardHeight.ts reserves exactly this.
function PostCardBody({
  media,
  textUnderMedia,
  textLines,
  textStack,
}: {
  /** The media surface, or null for a card without media. */
  media: ReactNode;
  /** The descriptor's `textUnderMedia`. */
  textUnderMedia: boolean;
  /** The lines the text stack paints, top to bottom. */
  textLines: readonly CardTextLine[];
  /** The text under the media, or null when there is none. */
  textStack: ReactNode;
}) {
  const first = textLines[0];
  const last = textLines[textLines.length - 1];
  const body = (
    <FramedCardBody
      media={media}
      textUnderMedia={textUnderMedia}
      text={textStack !== null && first && last ? textStack : null}
      textStyle={first && last ? {
        paddingInline: EDGE_TEXT_SIDE_PX,
        paddingTop: edgeTextTop(first),
        paddingBottom: edgeTextBottom(last),
      } : undefined}
    />
  );
  // A text post's body rises past the top edge on a lift; it dissolves there
  // with the sidebar strip's fade curve.
  return media === null
    ? <div data-card-lift-fade="" style={TOP_LIFT_FADE_MASK_STYLE}>{body}</div>
    : body;
}
