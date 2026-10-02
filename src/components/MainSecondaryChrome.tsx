import { useDraggable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import type { IndexedBlock, LightBlock, TagCount, VaultStats } from "@/types";
import { ActivityIndicators } from "./ActivityIndicators";
import { ChromeRow, ChromeActions } from "./ChromeRow";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeCloseButton } from "./ChromeCloseButton";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "./ui/segmented-control";
import { FeedDisplayMenu } from "./FeedDisplayMenu";

export type DetailLinkMode = "all" | "linked";
export type MainViewMode = "grid" | "graph";

const DETAIL_LINK_MODE_OPTIONS: SegmentedControlOption<DetailLinkMode>[] = [
  { value: "all", label: "All" },
  { value: "linked", label: "Connected" },
];

const MAIN_VIEW_MODE_OPTIONS: SegmentedControlOption<MainViewMode>[] = [
  { value: "grid", label: "Grid" },
  { value: "graph", label: "Graph" },
];

const MAIN_VIEW_MODE_STORAGE_KEY = "mine.mainViewMode";
const RU_INTEGER_FORMATTER = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});

export function getStoredMainViewMode(): MainViewMode {
  return window.localStorage.getItem(MAIN_VIEW_MODE_STORAGE_KEY) === "graph" ? "graph" : "grid";
}

export function persistMainViewMode(mode: MainViewMode) {
  window.localStorage.setItem(MAIN_VIEW_MODE_STORAGE_KEY, mode);
}

function formatPluralCount(count: number, singular: string, plural: string): string {
  return `${RU_INTEGER_FORMATTER.format(count)} ${count === 1 ? singular : plural}`;
}

function MainSecondaryStatsLeft({
  collectionCount,
  onCreateCollection,
  sidebarCollapsed,
  cloudPending,
  indexing,
  onRevealSpace,
}: {
  collectionCount: number;
  onCreateCollection?: () => void;
  sidebarCollapsed: boolean;
  cloudPending: number;
  indexing: boolean;
  onRevealSpace?: () => void;
}) {
  if (sidebarCollapsed) return null;

  return (
    <div
      data-main-secondary-stats-left=""
      // Over the sidebar column: the header of the list below it. The count of
      // its collections on the rows' edge pad, the button that adds one right
      // after it, the gap the elements half over the feed keeps between its
      // count and View.
      className="flex h-full min-w-0 items-center justify-start gap-5 overflow-hidden px-[var(--chrome-edge-pad)] font-mono text-sm leading-none text-tertiary-foreground"
    >
      <span data-main-secondary-collection-count="" className="min-w-0 truncate whitespace-nowrap">
        {formatPluralCount(collectionCount, "collection", "collections")}
      </span>
      {onCreateCollection && (
        <Button
          type="button"
          variant="chrome"
          size="chrome-icon"
          aria-label="New Collection"
          onClick={onCreateCollection}
          // The plate's 4px of air sits inside the gap: the glyph, not the
          // plate, stands one gap from the count.
          className="-ml-1"
          data-main-secondary-new-collection=""
        >
          <Plus />
        </Button>
      )}
      <ActivityIndicators
        cloudPending={cloudPending}
        indexing={indexing}
        onRevealSpace={onRevealSpace}
      />
    </div>
  );
}

function MainSecondaryStatsRight({
  stats,
  viewMode,
  onViewModeChange,
}: {
  stats: VaultStats | null;
  viewMode: MainViewMode;
  onViewModeChange: (value: MainViewMode) => void;
}) {
  const inCollection = Boolean(stats?.currentCollection);
  const cardCount = stats
    ? `${formatPluralCount(stats.currentCollectionCardCount, "element", "elements")}${inCollection ? " in collection" : ""}`
    : "";
  // The Display options belong to the feed only (SPEC_FEED_DISPLAY.md, Д4).
  const feedDisplay = viewMode === "grid";

  return (
    <div
      data-main-secondary-stats-right=""
      className={cn(
        "flex h-full min-w-0 items-center justify-start gap-5 overflow-hidden pl-[var(--main-secondary-pad-x)] font-mono text-sm leading-none text-tertiary-foreground",
        // With actions at the end, ChromeActions owns the right edge inset.
        !feedDisplay && "pr-[var(--main-secondary-pad-x)]",
      )}
    >
      {stats && (
        <span className="min-w-0 truncate whitespace-nowrap" title={cardCount}>
          {cardCount}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-2" data-main-view-mode-switcher="">
        <span className="shrink-0 font-mono text-sm text-tertiary-foreground">View:</span>
        <MainViewModeSwitch value={viewMode} onChange={onViewModeChange} entered />
      </div>
      {/* On the Mine button's axis: the same icon button and edge inset as
          the logo in the row above (SPEC_FEED_DISPLAY.md, Д1). */}
      {feedDisplay && (
        <ChromeActions className="ml-auto" data-feed-display="">
          <FeedDisplayMenu />
        </ChromeActions>
      )}
    </div>
  );
}

/// What the open note is, in the same voice the space statistics use.
///
/// At the foot of the window this replaces the space's own numbers while a
/// card is open: the row describes whatever the content area is showing, and
/// the content area is showing one note. The title and the close control are
/// not repeated here — in this layout they live in the top toolbar.
function MainSecondaryNoteMeta({
  block,
}: {
  /// Either shape the row is handed: the feed's light row or a freshly
  /// indexed block. Only the fields common to both are read.
  block: Pick<
    LightBlock,
    "saved_at" | "width" | "height" | "media_urls" | "author"
  >;
}) {
  // No type atom: the type taxonomy is gone (decision 044), and a projection
  // of it in the meta row would keep the dead concept on screen.
  const atoms: string[] = [];

  const saved = new Date(block.saved_at);
  if (!Number.isNaN(saved.getTime())) {
    atoms.push(
      saved.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }),
    );
  }

  if (block.width && block.height && block.width > 0 && block.height > 0) {
    atoms.push(`${block.width}×${block.height}`);
  }

  const mediaCount = countMediaUrls(block.media_urls);
  if (mediaCount > 1) {
    atoms.push(formatPluralCount(mediaCount, "media", "media"));
  }

  if (block.author) {
    atoms.push(block.author);
  }

  return (
    <div
      data-main-secondary-note-meta=""
      className="flex h-full min-w-0 items-center gap-5 overflow-hidden px-[var(--main-secondary-pad-x)] font-mono text-sm leading-none text-tertiary-foreground"
    >
      {atoms.map((atom) => (
        <span key={atom} className="min-w-0 shrink-0 truncate whitespace-nowrap">
          {atom}
        </span>
      ))}
    </div>
  );
}

/// `media_urls` is a JSON array when the indexer found inline media, and
/// absent otherwise. A malformed value is worth no crash and no guess.
function countMediaUrls(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function MainSecondaryTopBar({
  sidebarCollapsed,
  sidebarResizing,
  onCreateCollection,
  stats,
  detailBlock,
  detailTitle,
  detailEntered,
  detailLinkMode,
  onDetailLinkModeChange,
  viewMode,
  onViewModeChange,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onDetailClose,
  detailMenuOpenRequestSequence,
  cloudPending = 0,
  indexing = false,
  onRevealSpace,
  placement = "top",
  selectionActive = false,
  selectionHostRef,
}: {
  sidebarCollapsed: boolean;
  sidebarResizing: boolean;
  /// Starts naming a new collection in the sidebar list (⇧⌘N).
  onCreateCollection?: () => void;
  stats: VaultStats | null;
  /// Cards whose content iCloud is currently holding.
  cloudPending?: number;
  /// Whether the space is being indexed right now.
  indexing?: boolean;
  /// Reveal the space folder so the user can mark it Keep Downloaded.
  onRevealSpace?: () => void;
  detailBlock?: LightBlock | IndexedBlock | null;
  detailTitle?: string;
  detailEntered?: boolean;
  detailLinkMode: DetailLinkMode;
  onDetailLinkModeChange: (value: DetailLinkMode) => void;
  viewMode: MainViewMode;
  onViewModeChange: (value: MainViewMode) => void;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onDetailClose: () => void;
  detailMenuOpenRequestSequence: number;
  /// Where the row sits in the shell. At the foot of the window it takes the
  /// button bar's surface and closes with a separator on top instead of below —
  /// the seam always faces the content.
  placement?: "top" | "bottom";
  /// A group selection exists: its commands take the whole row over.
  selectionActive?: boolean;
  /// Where the feed portals the selection's commands into.
  selectionHostRef?: (element: HTMLDivElement | null) => void;
}) {
  const detailLayerEntered = Boolean(detailBlock && detailEntered);
  const mainLayerEntered = !detailLayerEntered;
  // The selection takes over the content half only: the stats over the sidebar
  // are not what it replaces, and its commands belong over the feed they act on.
  const contentMainLayerEntered = mainLayerEntered && !selectionActive;
  const closeChromeGesture = useChromeDragGesture({ disabled: !detailBlock });
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragHandleRef,
    isDragging,
  } = useDraggable({
    id: `detail-secondary:${detailBlock?.slug ?? "__empty__"}`,
    disabled: !detailBlock,
    data: detailBlock
      ? { type: "block", slug: detailBlock.slug, block: detailBlock }
      : undefined,
  });

  return (
    <ChromeRow
      data-tauri-drag-region
      data-main-secondary-top-bar=""
      className={cn(
        "transition-colors duration-[170ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        placement === "bottom" && "bg-accent",
        // A selection does not change the row's surface: the components on the
        // layer compute their fills from whatever the surface is (relative
        // elevation), so the ground stays put and only the content swaps.
        placement === "top" && (detailLayerEntered ? "bg-accent" : "bg-chrome"),
      )}
      data-main-secondary-placement={placement}
      separator={placement === "bottom" ? "top" : "bottom"}
    >
      <div
        data-tauri-drag-region
        data-main-secondary-top-bar-sidebar-segment=""
        className={cn(
          "relative flex h-full shrink-0 items-center overflow-hidden border-r border-sidebar-border",
          sidebarCollapsed && "w-auto max-w-[240px]",
          !sidebarResizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        )}
        style={sidebarCollapsed ? undefined : { width: "var(--sidebar-width)" }}
      >
        <div
          className="main-secondary-bar-layer absolute inset-0"
          data-entered={mainLayerEntered ? "true" : "false"}
          data-main-secondary-main-layer=""
        >
          <MainSecondaryStatsLeft
            collectionCount={tags.length}
            onCreateCollection={onCreateCollection}
            sidebarCollapsed={sidebarCollapsed}
            cloudPending={cloudPending}
            indexing={indexing}
            onRevealSpace={onRevealSpace}
          />
        </div>
        {detailBlock && !sidebarCollapsed && (
          <div
            className="main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 items-center gap-2 px-[var(--chrome-edge-pad)]"
            data-entered={detailLayerEntered ? "true" : "false"}
            data-secondary-sidebar-link-mode-bar=""
          >
            {/* A label in the voice of View: over the feed. */}
            <span className="shrink-0 font-mono text-sm text-tertiary-foreground">Collections:</span>
            <CompactDetailLinkModeSwitch
              value={detailLinkMode}
              onChange={onDetailLinkModeChange}
              chromeDragEnabled={false}
              entered={detailEntered}
            />
            {onCreateCollection && (
              <Button
                type="button"
                variant="chrome"
                size="chrome-icon"
                aria-label="New Collection"
                onClick={onCreateCollection}
                data-secondary-link-mode-new-collection=""
              >
                <Plus />
              </Button>
            )}
          </div>
        )}
      </div>
      <div
        data-tauri-drag-region
        data-main-secondary-top-bar-content-segment=""
        className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden"
      >
        {/* The selection replaces this half's ordinary content — the element
            count and the view switch — not the whole row: its commands sit
            over the feed they act on, the sidebar keeps its stats. The host
            stays mounted so the feed's portal target exists before the first
            selected card. */}
        <div
          className={cn(
            "main-secondary-bar-layer absolute inset-0 z-10",
            !selectionActive && "pointer-events-none",
          )}
          data-entered={selectionActive ? "true" : "false"}
          data-secondary-selection-bar=""
        >
          <div ref={selectionHostRef} className="h-full w-full" />
        </div>
        <div
          className="main-secondary-bar-layer absolute inset-0"
          data-entered={contentMainLayerEntered ? "true" : "false"}
          data-main-secondary-main-layer=""
        >
          <MainSecondaryStatsRight
            stats={stats}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
          />
        </div>
        {/* At the foot of the window the title, the card menu and the close
            control belong to the top toolbar, so this half shows what the note
            is instead of repeating its name. */}
        {detailBlock && placement === "bottom" && (
          <div
            className="main-secondary-bar-layer absolute inset-0"
            data-entered={detailLayerEntered ? "true" : "false"}
            data-secondary-detail-note-meta=""
          >
            <MainSecondaryNoteMeta block={detailBlock} />
          </div>
        )}
        {detailBlock && placement === "top" && (
          <div
            className="main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 flex-1 items-center gap-1 pl-[var(--chrome-edge-pad)]"
            data-entered={detailLayerEntered ? "true" : "false"}
            data-secondary-detail-top-menu=""
          >
            <div
              ref={setDragHandleRef}
              {...dragAttributes}
              {...dragListeners}
              className={cn(
                "min-w-0 flex-1 cursor-grab truncate font-mono text-sm text-muted-foreground active:cursor-grabbing",
                isDragging && "opacity-30",
              )}
              title={detailTitle}
              data-secondary-detail-drag-handle=""
            >
              {detailTitle}
            </div>
            <ChromeActions>
            <CardMoreMenu
              block={detailBlock}
              vaultPath={vaultPath}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              triggerVariant="chrome"
              openRequestSequence={detailMenuOpenRequestSequence}
              topChromeInteraction
            />
            <ChromeCloseButton {...closeChromeGesture} onClick={onDetailClose} />
            </ChromeActions>
          </div>
        )}
      </div>
    </ChromeRow>
  );
}

export function CompactDetailLinkModeSwitch({
  value,
  onChange,
  chromeDragEnabled = true,
  entered,
  className,
}: {
  value: DetailLinkMode;
  onChange: (value: DetailLinkMode) => void;
  chromeDragEnabled?: boolean;
  entered?: boolean;
  className?: string;
}) {
  const chromeGesture = useChromeDragGesture({ disabled: !chromeDragEnabled });

  return (
    <SegmentedControl
      chrome
      {...chromeGesture}
      value={value}
      options={DETAIL_LINK_MODE_OPTIONS}
      onChange={onChange}
      aria-label="Collection filter"
      data-entered={entered === undefined ? undefined : entered ? "true" : "false"}
      data-compact-detail-link-mode-control=""
      className={className}
    />
  );
}

function MainViewModeSwitch({
  value,
  onChange,
  entered,
  className,
}: {
  value: MainViewMode;
  onChange: (value: MainViewMode) => void;
  entered?: boolean;
  className?: string;
}) {
  return (
    <SegmentedControl
      chrome
      value={value}
      options={MAIN_VIEW_MODE_OPTIONS}
      onChange={onChange}
      aria-label="View mode"
      data-entered={entered === undefined ? undefined : entered ? "true" : "false"}
      data-main-view-mode-control=""
      className={className}
    />
  );
}

/// The card title in the compact top menu is the block's drag handle, exactly
/// as the filename is in the classic Detail header.
///
/// It used to be a `data-tauri-drag-region` instead, which silently swapped
/// the gesture's meaning with the chrome mode: the same grab that dragged the
/// card into a collection under the classic header started dragging the
/// window under the compact one. The window keeps its drag surface on the
/// header's empty stretches; the card's identity stays draggable everywhere
/// it is shown.
function CompactDetailCardTitleDragHandle({
  block,
  cardTitle,
}: {
  block: LightBlock | IndexedBlock;
  cardTitle: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `detail:${block.slug}`,
    data: {
      type: "block",
      slug: block.slug,
      block,
    },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "min-w-0 flex-1 cursor-grab truncate pl-0 pr-3 font-mono text-sm text-muted-foreground active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
      title={cardTitle}
      data-compact-detail-card-title=""
      data-detail-drag-handle
    >
      {cardTitle}
    </div>
  );
}

export function CompactDetailTopMenu({
  block,
  cardTitle,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onClose,
  menuOpenRequestSequence,
  entered,
}: {
  block: LightBlock | IndexedBlock;
  cardTitle: string;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onClose: () => void;
  menuOpenRequestSequence: number;
  entered: boolean;
}) {
  const closeChromeGesture = useChromeDragGesture();

  return (
    <div
      className="detail-top-bar-enter flex h-full min-w-0 flex-1 items-center"
      data-entered={entered ? "true" : "false"}
      data-compact-detail-top-menu=""
    >
      <CompactDetailCardTitleDragHandle block={block} cardTitle={cardTitle} />
      <ChromeActions windowEdge={false}>
      <CardMoreMenu
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        triggerVariant="chrome"
        openRequestSequence={menuOpenRequestSequence}
        topChromeInteraction
      />
      <ChromeCloseButton {...closeChromeGesture} onClick={onClose} />
      </ChromeActions>
    </div>
  );
}
