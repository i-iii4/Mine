import type { Ref } from "react";
import { getFileName } from "@/lib/displayTitle";
import { commandById } from "@/lib/commandRegistry";
import { cn } from "@/lib/utils";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import type {
  IndexedBlock,
  LightBlock,
  MainViewMode,
  RenameBlockError,
  TagCount,
} from "@/types";
import { ChromeActions } from "./ChromeRow";
import { ChromeNameField, type ChromeNameFieldHandle } from "./ChromeNameField";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { renameErrorMessage } from "./RenameBlockDialog";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { GraphDisplayMenu } from "./GraphDisplayMenu";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { ViewToggleIcon } from "./ViewToggleIcon";
import { sidebarWidthHost } from "@/lib/sidebarWidth";


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
/// of its own and stands after the place's name, or in its room while an open
/// card's name stands here (DESIGN_SYSTEM.md, «Верхние ряды», «Одно название
/// в ряду»).
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
  nameFieldRef,
  onRequestDelete,
  onDetailClose,
  onDetailCollapse,
  detailMenuOpenRequestSequence,
  selectionActive = false,
  selectionHostRef,
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
  /// The open card's name, for the card's `Rename…` to reach.
  nameFieldRef?: Ref<ChromeNameFieldHandle>;
  onRequestDelete: (slug: string) => void;
  onDetailClose: () => void;
  /// Chooses «Card view: Peek» and gives the open card to its window
  /// (SPEC_CARD_PEEK.md, О9, О16): offered while the right part holds the
  /// window, whatever «Card view» was, else absent.
  onDetailCollapse?: () => void;
  detailMenuOpenRequestSequence: number;
  /// A group selection exists: its commands take this half over.
  selectionActive?: boolean;
  /// Where the feed portals the selection's commands into.
  selectionHostRef?: (element: HTMLDivElement | null) => void;
}) {
  const detailLayerEntered = Boolean(detailBlock && detailEntered);
  // The selection's commands belong over the feed they act on.
  const contentMainLayerEntered = !detailLayerEntered && !selectionActive;
  const closeChromeGesture = useChromeDragGesture({ disabled: !detailBlock });
  const collapseChromeGesture = useChromeDragGesture({ disabled: !detailBlock || !onDetailCollapse });

  // An open card's name never stands with the place's name in the row
  // (topRowPath.ts; user's decision of 11.11.2026): it takes the place's room,
  // from the window's edge or the line of the sidebar's segment, and no line
  // stands before it.
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
      // In the second row it stands from the sidebar's width, which does
      // not inherit (sidebarWidth.ts).
      ref={sidebarWidthHost}
      className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden"
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
          // The name's pill keeps the 8 px the place's name keeps from the
          // window's edge or the segment's line.
          className="main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 flex-1 items-center gap-1 pl-[var(--top-collection-pad-x)]"
          data-entered={detailLayerEntered ? "true" : "false"}
          data-secondary-detail-top-menu=""
        >
          <DetailCardFileName
            block={detailBlock}
            onRename={onRenameFile}
            onCheck={onCheckFileName}
            fieldRef={nameFieldRef}
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
          {/* Where the card's window holds its way to full page, between the
              menu and the close (user's decision of 30.10.2026). */}
          {onDetailCollapse && (
            <Button
              {...collapseChromeGesture}
              type="button"
              variant="chrome"
              size="chrome-icon"
              aria-label="Collapse to window"
              onClick={onDetailCollapse}
              data-secondary-detail-collapse=""
            >
              <ViewToggleIcon to="window" />
            </Button>
          )}
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
/// (user's decisions of 05.10.2026), as `ChromeNameField` renames a name in
/// the path. The open card's window names it the same way in its plate
/// (CardPeek.tsx, SPEC_CARD_PEEK.md, О9).
export function DetailCardFileName({
  block,
  onRename,
  onCheck,
  fieldRef,
}: {
  block: LightBlock | IndexedBlock;
  onRename: (block: LightBlock | IndexedBlock, newStem: string) => Promise<void>;
  onCheck: FileNameCheck;
  fieldRef?: Ref<ChromeNameFieldHandle>;
}) {
  const fileName = getFileName(block);
  return (
    <ChromeNameField
      ref={fieldRef}
      name={fileName}
      title={fileName}
      fieldLabel="Rename file"
      check={(typed) => onCheck(block, typed).then((problem) => (
        problem ? renameErrorMessage(problem) : null
      ))}
      save={(typed) => onRename(block, typed)}
      reasonOf={refusalMessage}
      resetKey={block.slug}
      marker="secondary-detail-card-name"
    />
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
