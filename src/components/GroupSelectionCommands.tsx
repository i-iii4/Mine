import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BatchCollectionPicker,
  COLLECTION_PICKER_CONTENT_CLASS,
  type MembershipAnswer,
} from "./CollectionPicker";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { ChromeActions } from "./ChromeRow";
import { commandById } from "@/lib/commandRegistry";
import type { LightBlock, TagCount } from "@/types";
import { selectedElementCountLabel } from "@/lib/groupSelection";
import { useGroupSelectionMenuActions } from "@/hooks/useGroupSelectionMenuActions";

interface GroupSelectionCommandsProps {
  selectedBlocks: LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => MembershipAnswer;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<unknown>;
  /** The feed's `requestDeleteSelection()`: the window is the feed's, not
   *  the row's (SPEC_GROUP_SELECTION.md, «Точки входа»). */
  onRequestDeleteSelection: () => void;
  onMergeSelectedBlocks: () => void;
  onClearSelection: () => void;
}

export function GroupSelectionCommands({
  selectedBlocks,
  tags,
  currentTag,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onRequestDeleteSelection,
  onMergeSelectedBlocks,
  onClearSelection,
}: GroupSelectionCommandsProps) {
  const actions = useGroupSelectionMenuActions({
    selectedBlocks,
    currentTag,
    onLoadBlockTags,
    onBatchSetTag,
    onCreateAndAssignBatch,
  });

  // The selection stays until the answer: a Disconnect that was not made
  // keeps it, to be tried again, and the tab's notice says why
  // (SPEC_DEEP_AUDIT.md, Е6.1).
  const handleRemoveFromCollection = () => {
    void actions.disconnectFromCurrentCollection().then((applied) => {
      if (applied) onClearSelection();
    });
  };

  if (selectedBlocks.length === 0) return null;

  return (
    <div
      className="relative h-full w-full text-foreground"
      data-feed-selection-action-bar=""
    >
      {/* The count holds the left; the commands and the close control stand
          at the right in ChromeActions, which owns the right edge inset as in
          every chrome row (DESIGN_SYSTEM.md, «Иконочные кнопки хрома»). When
          the row narrows, the count truncates (`w-0` keeps its text out of the
          row's min-content) while the commands keep their size; commands the
          top row cannot hold send this half to a second row
          (SPEC_NARROW_WINDOW.md, У10), and where even that row is too narrow
          they scroll. A truncated count alone moves nothing. The pads live on
          the scrolled content, not the scrollport: a scroll container's end
          padding never renders past its content. */}
      <div className="h-full max-w-full overflow-x-auto overflow-y-hidden">
        <div
          className="flex h-full w-full min-w-min items-center gap-1 pl-[var(--main-secondary-pad-x,0.5rem)]"
          data-top-row-part="whole"
        >
          <div
            className="w-0 min-w-0 flex-1 truncate px-2 font-mono text-sm text-muted-foreground"
            data-feed-selection-count=""
          >
            {`${selectedElementCountLabel(selectedBlocks.length)} selected`}
          </div>

          <ChromeActions data-feed-selection-actions="">
            <DropdownMenu open={actions.connectOpen} onOpenChange={actions.setConnectOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  className="shrink-0"
                >
                  <Plus className="size-[13px]" />
                  Connect
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent widthRole="search" className={COLLECTION_PICKER_CONTENT_CLASS} align="end">
                <BatchCollectionPicker
                  selectedSlugs={actions.selectedSlugs}
                  tags={tags}
                  tagLookup={actions.tagLookup}
                  onBatchSetTag={actions.batchSetTag}
                  onCreateAndAssign={actions.createAndAssignBatch}
                />
              </DropdownMenuContent>
            </DropdownMenu>

            {currentTag && (
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0 text-detach"
                onClick={handleRemoveFromCollection}
              >
                Disconnect
              </Button>
            )}

            {selectedBlocks.length >= 2 && (
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0"
                onClick={onMergeSelectedBlocks}
              >
                Merge
              </Button>
            )}

            <Button
              type="button"
              variant="destructive"
              size="xs"
              className="shrink-0"
              onClick={onRequestDeleteSelection}
            >
              Delete
            </Button>

            <ChromeCloseButton
              label="Clear selection"
              shortcut={commandById("clear-selection").combo}
              onClick={onClearSelection}
            />
          </ChromeActions>
        </div>
      </div>
      {actions.actionError && (
        <p className="absolute left-1/2 top-full z-40 mt-2 -translate-x-1/2 rounded-1 border border-destructive bg-background px-3 py-1 text-sm text-destructive">
          {actions.actionError}
        </p>
      )}
    </div>
  );
}
