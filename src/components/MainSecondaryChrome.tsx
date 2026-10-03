import { useDraggable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commandById } from "@/lib/commandRegistry";
import { cn } from "@/lib/utils";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import type {
  IndexedBlock,
  LightBlock,
  MainViewMode,
  TagCount,
  VaultStats,
} from "@/types";
import { ActivityIndicators } from "./ActivityIndicators";
import { ChromeRow, ChromeActions } from "./ChromeRow";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeCloseButton } from "./ChromeCloseButton";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "./ui/segmented-control";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";


const MAIN_VIEW_MODE_OPTIONS: SegmentedControlOption<MainViewMode>[] = [
  { value: "grid", label: "Grid" },
  { value: "graph", label: "Graph" },
];

const RU_INTEGER_FORMATTER = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});

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
      // Over the sidebar column: the header of the list below it, laid out
      // like the elements half over the feed. The count of its collections on
      // the rows' edge pad at the left; the button that adds one at the right
      // edge, where ChromeActions owns the inset, as it does for Display.
      className={cn(
        "flex h-full min-w-0 items-center justify-start gap-5 overflow-hidden pl-[var(--chrome-edge-pad)] font-mono text-sm leading-none text-tertiary-foreground",
        !onCreateCollection && "pr-[var(--chrome-edge-pad)]",
      )}
    >
      <span data-main-secondary-collection-count="" className="min-w-0 truncate whitespace-nowrap">
        {formatPluralCount(collectionCount, "collection", "collections")}
      </span>
      <ActivityIndicators
        cloudPending={cloudPending}
        indexing={indexing}
        onRevealSpace={onRevealSpace}
      />
      {onCreateCollection && (
        // 8px from the column's edge, the inset the sidebar rows give their
        // Connect button, and the filter's clear button above.
        <ChromeActions windowEdge={false} className="ml-auto mr-2">
          <Button
            type="button"
            variant="chrome"
            size="chrome-icon"
            aria-label="New Collection"
            onClick={onCreateCollection}
            data-main-secondary-new-collection=""
          >
            <Plus />
          </Button>
        </ChromeActions>
      )}
    </div>
  );
}

function MainSecondaryStatsRight({
  stats,
  viewMode,
  onViewModeChange,
  afterPath = false,
}: {
  stats: VaultStats | null;
  viewMode: MainViewMode;
  onViewModeChange: (value: MainViewMode) => void;
  /// Right after the path's last pill in the row above (interface version 2):
  /// 12 px, so the count stands 20 px from the chevron, the gap between the
  /// block's own groups (`gap-5`).
  afterPath?: boolean;
}) {
  const inCollection = Boolean(stats?.currentCollection);
  const cardCount = stats
    ? `${formatPluralCount(stats.currentCollectionCardCount, "element", "elements")}${inCollection ? " in collection" : ""}`
    : "";
  // The Display options belong to the feed only (SPEC_FEED_DISPLAY.md, Д4).
  const feedDisplay = viewMode === "grid";

  // Interface version 2: no count and no `View:` prefix; the view switch
  // stands at the right with the Display button, on a permanent plate as
  // the sidebar's filter has it (DESIGN_SYSTEM.md, «Версии интерфейса»).
  if (afterPath) {
    return (
      <div
        data-main-secondary-stats-right=""
        className="flex h-full min-w-0 items-center justify-end font-mono text-sm leading-none text-tertiary-foreground"
      >
        <ChromeActions data-main-view-mode-switcher="" data-feed-display={feedDisplay ? "" : undefined}>
          <MainViewModeTabs value={viewMode} onChange={onViewModeChange} />
          {feedDisplay && <FeedDisplayMenu />}
        </ChromeActions>
      </div>
    );
  }

  return (
    <div
      data-main-secondary-stats-right=""
      className={cn(
        "flex h-full min-w-0 items-center justify-start gap-5 overflow-hidden font-mono text-sm leading-none text-tertiary-foreground",
        "pl-[var(--main-secondary-pad-x)]",
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
  collectionCount,
  stats,
  detailBlock,
  detailTitle,
  detailEntered,
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
  part = "both",
  selectionActive = false,
  selectionHostRef,
}: {
  sidebarCollapsed: boolean;
  sidebarResizing: boolean;
  /// Starts naming a new collection in the sidebar list (⇧⌘N).
  onCreateCollection?: () => void;
  /// How many collections the list shows: all of them, or those the
  /// sidebar's filter leaves. Defaults to every collection.
  collectionCount?: number;
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
  /// Which half to draw. At the top of the window the row has no half over
  /// the sidebar since 03.10.2026: version 1 draws the half over the feed as
  /// a row over the feed column (`feed`), version 2 folds it into the row
  /// above (`content`, without a row of its own). At the foot of the window
  /// the row keeps both halves (`both`).
  part?: "both" | "content" | "feed";
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

  const sidebarSegment = (
    <div
      data-tauri-drag-region
      data-main-secondary-top-bar-sidebar-segment=""
      className={cn(
        "relative flex h-full shrink-0 items-center overflow-hidden border-r border-sidebar-border",
        sidebarCollapsed && "w-auto max-w-[240px]",
        // Right over the sidebar's table the segment takes the table's
        // surface; an open card's accent still marks the whole row.
        placement === "top" && !sidebarCollapsed && !detailLayerEntered && "bg-sidebar",
        !sidebarResizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={sidebarCollapsed ? undefined : { width: "var(--sidebar-width)" }}
    >
      {/* The stats stay while a card is open: the All / Connected switch
          that took their place left every mode (03.10.2026). */}
      <div
        className="main-secondary-bar-layer absolute inset-0"
        data-entered="true"
        data-main-secondary-main-layer=""
      >
        <MainSecondaryStatsLeft
          collectionCount={collectionCount ?? tags.length}
          onCreateCollection={onCreateCollection}
          sidebarCollapsed={sidebarCollapsed}
          cloudPending={cloudPending}
          indexing={indexing}
          onRevealSpace={onRevealSpace}
        />
      </div>
    </div>
  );
  const contentSegment = (
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
          afterPath={part === "content"}
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
          className={cn(
            "main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 flex-1 items-center gap-1",
            part === "content" ? "pl-0" : "pl-[var(--chrome-edge-pad)]",
          )}
          data-entered={detailLayerEntered ? "true" : "false"}
          data-secondary-detail-top-menu=""
        >
          <div
            ref={setDragHandleRef}
            {...dragAttributes}
            {...dragListeners}
            className={cn(
              "min-w-0 cursor-grab truncate font-mono text-sm text-muted-foreground active:cursor-grabbing",
              // In the path it is a pill like the space and the collection
              // before it: the same inner padding and hover plate.
              part === "content"
                ? "h-6 rounded-1 px-2 leading-6 hover:bg-active hover:text-foreground"
                : "flex-1",
              isDragging && "opacity-30",
            )}
            title={detailTitle}
            data-secondary-detail-drag-handle=""
          >
            {detailTitle}
          </div>
          <ChromeActions className={part === "content" ? "ml-auto" : undefined}>
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
            triggerShortcut={commandById("element-menu-open").combo}
            openRequestSequence={detailMenuOpenRequestSequence}
            topChromeInteraction
          />
          <ChromeCloseButton {...closeChromeGesture} onClick={onDetailClose} />
          </ChromeActions>
        </div>
      )}
    </div>
  );
  // The half over the feed stands in the row above it, with no row of its own.
  if (part === "content") return contentSegment;

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
      {part === "both" && sidebarSegment}
      {contentSegment}
    </ChromeRow>
  );
}


/** Grid and Graph as chrome tabs on a permanent plate (version 2). */
function MainViewModeTabs({
  value,
  onChange,
}: {
  value: MainViewMode;
  onChange: (value: MainViewMode) => void;
}) {
  const choose = (next: string) => {
    const option = MAIN_VIEW_MODE_OPTIONS.find((candidate) => candidate.value === next);
    if (option) onChange(option.value);
  };
  return (
    <Tabs value={value} onValueChange={choose} className="h-full gap-0">
      <TabsList variant="chrome" plate="always" aria-label="View mode" data-main-view-mode-control="">
        {MAIN_VIEW_MODE_OPTIONS.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
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
            triggerShortcut={commandById("element-menu-open").combo}
        openRequestSequence={menuOpenRequestSequence}
        topChromeInteraction
      />
      <ChromeCloseButton {...closeChromeGesture} onClick={onClose} />
      </ChromeActions>
    </div>
  );
}
