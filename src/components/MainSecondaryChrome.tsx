import { useEffect, useRef, useState } from "react";
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
} from "@/types";
import { ChromeActions } from "./ChromeRow";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { renameErrorMessage } from "./RenameBlockDialog";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { GraphDisplayMenu } from "./GraphDisplayMenu";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";


const MAIN_VIEW_MODE_OPTIONS: readonly { value: MainViewMode; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "graph", label: "Graph" },
];

/// The view switch and the Display button, at the right of the half over the
/// feed: no element count and no `View:` prefix, the switch on a permanent
/// plate as the sidebar's filter has it (DESIGN_SYSTEM.md, «Верхние ряды»).
function MainSecondaryViewActions({
  viewMode,
  viewModeSwitch = true,
  onViewModeChange,
}: {
  viewMode: MainViewMode;
  /// Whether the place has a graph to switch to: an author's feed is a grid
  /// only (SPEC_CARD_ASSOCIATIONS.md, «Лента автора»).
  viewModeSwitch?: boolean;
  onViewModeChange: (value: MainViewMode) => void;
}) {
  // The Display button serves the view on screen: the feed's options in
  // Grid, the graph's links in Graph (SPEC_FEED_DISPLAY.md, Д4). The two are
  // different components, so switching the view closes an open panel.
  const displayMenu = viewMode === "graph" ? <GraphDisplayMenu /> : <FeedDisplayMenu />;
  return (
    <div
      data-main-secondary-stats-right=""
      className="flex h-full min-w-0 items-center justify-end font-mono text-sm leading-none text-tertiary-foreground"
    >
      <ChromeActions data-main-view-mode-switcher="" data-display-actions="">
        {viewModeSwitch && <MainViewModeTabs value={viewMode} onChange={onViewModeChange} />}
        {displayMenu}
      </ChromeActions>
    </div>
  );
}

/// The half of the second row over the feed: since 03.10.2026 it has no row
/// of its own and stands after the collection switcher (DESIGN_SYSTEM.md,
/// «Верхние ряды»).
export function MainSecondaryTopBar({
  detailBlock,
  detailEntered,
  viewMode,
  viewModeSwitch = true,
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
  selectionActive = false,
  selectionHostRef,
  placeBefore = true,
}: {
  detailBlock?: LightBlock | IndexedBlock | null;
  detailEntered?: boolean;
  viewMode: MainViewMode;
  /// Whether `Grid / Graph` is offered: not in an author's feed.
  viewModeSwitch?: boolean;
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
  /// A group selection exists: its commands take this half over.
  selectionActive?: boolean;
  /// Where the feed portals the selection's commands into.
  selectionHostRef?: (element: HTMLDivElement | null) => void;
  /// The place's switcher stands before this half in the row, and an open
  /// card's name stands past the path's line. Without it (an open card in a
  /// narrow window, SPEC_NARROW_WINDOW.md, У15; topRowPath.ts) the half
  /// starts the row: no line, the name keeps only its outer padding from the
  /// window's edge, as the switcher would.
  placeBefore?: boolean;
}) {
  const detailLayerEntered = Boolean(detailBlock && detailEntered);
  // The selection's commands belong over the feed they act on.
  const contentMainLayerEntered = !detailLayerEntered && !selectionActive;
  const closeChromeGesture = useChromeDragGesture({ disabled: !detailBlock });

  // In the path an open card's name stands past a line, the one the sidebar
  // segment draws between space and collection (11.10.2026). The half itself
  // draws it, 8 px past the collection's pill, so the collection switcher
  // keeps its box when a card opens or closes. It lives as long as the name
  // does, through the name's exit: the name fades where it stood, the line
  // leaves with it. A structural line, it does not ride the layer's motion.
  // With nothing before the half there is nothing to part (У15).
  const pathCardLine = Boolean(detailBlock) && placeBefore;
  return (
    <div
      data-tauri-drag-region
      data-main-secondary-top-bar-content-segment=""
      // When the row cannot hold the selection's commands, this half moves
      // into a second row right under it (SPEC_NARROW_WINDOW.md, У10;
      // useTopRowWrap.ts): global.css places it by the shell's
      // `data-top-row`. Nothing else of the half ever does: an open card's
      // name ends in an ellipsis as before.
      data-top-row-bar=""
      data-path-card-line={pathCardLine ? "" : undefined}
      className={cn(
        "relative flex h-full min-w-0 flex-1 items-center overflow-hidden",
        pathCardLine && "ml-[var(--top-collection-pad-x)] border-l border-sidebar-border",
      )}
    >
      {/* The selection replaces this half's ordinary content, the view
          switch, not the whole row: its commands sit over the feed they act
          on. The host stays mounted so the feed's portal target exists before
          the first selected card. */}
      <div
        className={cn(
          "main-secondary-bar-layer absolute inset-0 z-10",
          !selectionActive && "pointer-events-none",
        )}
        data-entered={selectionActive ? "true" : "false"}
        data-secondary-selection-bar=""
        data-top-row-wraps=""
      >
        <div ref={selectionHostRef} className="h-full w-full" />
      </div>
      <div
        className="main-secondary-bar-layer absolute inset-0"
        data-entered={contentMainLayerEntered ? "true" : "false"}
        data-main-secondary-main-layer=""
      >
        <MainSecondaryViewActions
          viewMode={viewMode}
          viewModeSwitch={viewModeSwitch}
          onViewModeChange={onViewModeChange}
        />
      </div>
      {detailBlock && (
        <div
          // Past the path's line the name's pill keeps the 8 px a switcher
          // keeps from a line.
          className="main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 flex-1 items-center gap-1 pl-[var(--top-collection-pad-x)]"
          data-entered={detailLayerEntered ? "true" : "false"}
          data-secondary-detail-top-menu=""
        >
          <DetailCardFileName
            block={detailBlock}
            onRename={onRenameFile}
            onCheck={onCheckFileName}
          />
          <ChromeActions className="ml-auto">
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
/// name is not dragged. In the path the name is a pill like the space and the
/// collection before it: the same inner padding and hover plate.
function DetailCardFileName({
  block,
  onRename,
  onCheck,
}: {
  block: LightBlock | IndexedBlock;
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
          className={cn("flex min-w-0", editing && "flex-1")}
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
              className="h-6 min-w-0 select-none truncate rounded-1 px-2 font-mono text-sm leading-6 text-muted-foreground hover:state-active hover:text-foreground"
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
