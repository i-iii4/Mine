import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getFileName } from "@/lib/displayTitle";
import { commandById } from "@/lib/commandRegistry";
import { cn } from "@/lib/utils";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import { NAME_REFUSED_SHAKE_MS, useNameEdit } from "@/hooks/useNameEdit";
import type {
  IndexedBlock,
  LightBlock,
  MainViewMode,
  RenameBlockError,
  TagCount,
  VaultStats,
} from "@/types";
import { ActivityIndicators } from "./ActivityIndicators";
import { ChromeRow, ChromeActions } from "./ChromeRow";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { renameErrorMessage } from "./RenameBlockDialog";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";


const MAIN_VIEW_MODE_OPTIONS: readonly { value: MainViewMode; label: string }[] = [
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
  // the sidebar's filter has it (DESIGN_SYSTEM.md, «Верхние ряды»).
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
        <MainViewModeTabs value={viewMode} onChange={onViewModeChange} />
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
  detailEntered,
  viewMode,
  onViewModeChange,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRenameFile,
  onCheckFileName,
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
  detailEntered?: boolean;
  viewMode: MainViewMode;
  onViewModeChange: (value: MainViewMode) => void;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  /// Renames the open card's file to a new name without its folder; rejects
  /// with a `RenameBlockError` when the name is refused.
  onRenameFile: (block: LightBlock | IndexedBlock, newStem: string) => Promise<void>;
  /// Whether a name typed for the open card would be refused, and why;
  /// writes nothing.
  onCheckFileName: (block: LightBlock | IndexedBlock, newStem: string) => Promise<RenameBlockError | null>;
  onRequestDelete: (slug: string) => void;
  onDetailClose: () => void;
  detailMenuOpenRequestSequence: number;
  /// Where the row sits in the shell. At the foot of the window it takes the
  /// button bar's surface and closes with a separator on top instead of below —
  /// the seam always faces the content.
  placement?: "top" | "bottom";
  /// Which half to draw. At the top of the window the row has no row of its
  /// own since 03.10.2026: its half over the feed folds into the row above
  /// (`content`). At the foot of the window the row keeps both halves
  /// (`both`).
  part?: "both" | "content";
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
          <DetailCardFileName
            block={detailBlock}
            inPath={part === "content"}
            onRename={onRenameFile}
            onCheck={onCheckFileName}
          />
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


function isRenameBlockError(value: unknown): value is RenameBlockError {
  return typeof value === "object" && value !== null && "kind" in value;
}

function refusalMessage(raw: unknown): string {
  return isRenameBlockError(raw) ? renameErrorMessage(raw) : "Could not rename the file.";
}

type FileNameCheck = (block: LightBlock | IndexedBlock, newStem: string) => Promise<RenameBlockError | null>;

/// The open card in the path is named by its file and renamed right there
/// (user's decisions of 05.10.2026). A double click turns the name into a
/// field; leaving the field or Enter saves, Escape keeps the old name. While
/// the typed name would be refused (a character Obsidian cannot link, a name
/// already taken) the reason stands right under it. A refused save shakes the
/// field once: after Enter the field stays, with the cursor and the typed
/// name; after leaving the field the old name returns and the reason stays a
/// moment (`useNameEdit`, shared with the sidebar's collection names). The
/// name is not dragged.
function DetailCardFileName({
  block,
  inPath,
  onRename,
  onCheck,
}: {
  block: LightBlock | IndexedBlock;
  /// In the path the name is a pill like the space and the collection before
  /// it: the same inner padding and hover plate.
  inPath: boolean;
  onRename: (block: LightBlock | IndexedBlock, newStem: string) => Promise<void>;
  onCheck: FileNameCheck;
}) {
  const fileName = getFileName(block);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const edit = useNameEdit({
    current: fileName,
    check: (typed) => onCheck(block, typed).then((problem) => (
      problem ? renameErrorMessage(problem) : null
    )),
    save: (typed) => onRename(block, typed),
    reasonOf: refusalMessage,
    end: () => setEditing(false),
  });

  // Another card in the path ends the edit, as Escape would.
  useEffect(() => {
    edit.cancel();
  }, [block.slug]);

  useEffect(() => {
    const input = inputRef.current;
    if (!editing || !input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [editing]);

  const startEditing = () => {
    edit.begin(fileName);
    setEditing(true);
  };

  return (
    <Tooltip open={edit.notice !== null}>
      <TooltipTrigger asChild>
        <div
          className={cn("flex min-w-0", (editing || !inPath) && "flex-1")}
          data-secondary-detail-card-name-anchor=""
        >
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              aria-label="Rename file"
              aria-invalid={edit.notice !== null}
              defaultValue={fileName}
              readOnly={edit.refused}
              spellCheck={false}
              autoComplete="off"
              // The plate stays while the name is a field, so its extent shows.
              className="state-active h-6 min-w-0 flex-1 rounded-1 border-0 bg-transparent px-2 font-mono text-sm leading-6 text-foreground outline-none"
              data-secondary-detail-card-name-input=""
              data-name-refused={edit.refused ? "" : undefined}
              style={{ animationDuration: `${NAME_REFUSED_SHAKE_MS}ms` }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  edit.submit(event.currentTarget.value);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  edit.cancel();
                }
              }}
              onChange={(event) => edit.change(event.currentTarget.value)}
              onBlur={(event) => edit.leave(event.currentTarget.value)}
            />
          ) : (
            <div
              onDoubleClick={startEditing}
              className={cn(
                "min-w-0 select-none truncate font-mono text-sm text-muted-foreground",
                inPath
                  ? "h-6 rounded-1 px-2 leading-6 hover:state-active hover:text-foreground"
                  : "flex-1",
              )}
              title={fileName}
              data-secondary-detail-card-name=""
            >
              {fileName}
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        className="max-w-80 text-destructive"
        data-secondary-detail-card-name-notice=""
      >
        {edit.notice}
      </TooltipContent>
    </Tooltip>
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
      <TabsList variant="chrome" aria-label="View mode" data-main-view-mode-control="">
        {MAIN_VIEW_MODE_OPTIONS.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/// The card title in the compact top menu behaves as the card's name does
/// in every chrome mode: it is not dragged, and a double click renames the
/// card (05.10.2026). The window keeps its drag surface on the header's empty
/// stretches.
function CompactDetailCardTitle({
  block,
  cardTitle,
  onRequestRename,
}: {
  block: LightBlock | IndexedBlock;
  cardTitle: string;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
}) {
  return (
    <div
      onDoubleClick={() => onRequestRename(block)}
      className="min-w-0 flex-1 select-none truncate pl-0 pr-3 font-mono text-sm text-muted-foreground"
      title={cardTitle}
      data-compact-detail-card-title=""
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
      <CompactDetailCardTitle block={block} cardTitle={cardTitle} onRequestRename={onRequestRename} />
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
