import { Plus, Trash2, Unlink } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { useGroupSelectionMenuActions } from "@/hooks/useGroupSelectionMenuActions";
import { selectedCardCountLabel } from "@/lib/groupSelection";
import type { LightBlock, TagCount } from "@/types";
import {
  BatchCollectionPicker,
  COLLECTION_PICKER_CONTENT_CLASS,
} from "./CollectionPicker";

interface GroupSelectionContextMenuProps {
  selectedBlocks: readonly LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onRequestDeleteSelected: () => void;
  onMergeSelectedBlocks: () => void;
  onClearSelection: () => void;
}

/// Right-click menu for a group selection — the context-menu twin of
/// `GroupSelectionCardMenu`.
///
/// Every command here acts on the whole selection, so the single-card commands
/// are absent by construction rather than disabled: `Reveal in Finder`,
/// `Copy Path` and `Rename…` address one file, and `Source` opens one URL.
/// Applying them to a selection would either pick a card silently or spray the
/// desktop with windows, and a menu that offers neither is the honest one.
///
/// The delete confirmation lives in the grid, not here: this content unmounts
/// the moment the menu closes, and a dialog mounted inside it would vanish with
/// the click that opened it.
export function GroupSelectionContextMenu({
  selectedBlocks,
  tags,
  currentTag,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onRequestDeleteSelected,
  onMergeSelectedBlocks,
  onClearSelection,
}: GroupSelectionContextMenuProps) {
  const actions = useGroupSelectionMenuActions({
    selectedBlocks,
    currentTag,
    onLoadBlockTags,
    onBatchSetTag,
    onCreateAndAssignBatch,
  });

  const handleDisconnectFromCollection = () => {
    actions.disconnectFromCurrentCollection();
    onClearSelection();
  };

  return (
    <ContextMenuContent data-feed-grid-selection-context-menu="">
      <div
        className="px-2 py-1.5 font-mono text-sm text-muted-foreground"
        data-feed-grid-selection-context-menu-count=""
      >
        {selectedCardCountLabel(selectedBlocks.length)}
      </div>
      <ContextMenuSeparator />
      <ContextMenuSub open={actions.connectOpen} onOpenChange={actions.setConnectOpen}>
        <ContextMenuSubTrigger>
          <MenuIconSlot>
            <Plus className="size-3" />
          </MenuIconSlot>
          Connect
        </ContextMenuSubTrigger>
        <ContextMenuSubContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS}>
          <BatchCollectionPicker
            selectedSlugs={actions.selectedSlugs}
            tags={tags}
            tagLookup={actions.tagLookup}
            onBatchSetTag={actions.batchSetTag}
            onCreateAndAssign={actions.createAndAssignBatch}
            onRequestClose={() => actions.setConnectOpen(false)}
          />
        </ContextMenuSubContent>
      </ContextMenuSub>
      {currentTag && (
        <ContextMenuItem variant="detach" onSelect={handleDisconnectFromCollection}>
          <MenuIconSlot>
            <Unlink className="size-3" />
          </MenuIconSlot>
          Disconnect
        </ContextMenuItem>
      )}
      {selectedBlocks.length >= 2 && (
        <ContextMenuItem onSelect={onMergeSelectedBlocks}>
          <MenuIconSlot />
          Merge
        </ContextMenuItem>
      )}
      <ContextMenuItem variant="destructive" onSelect={onRequestDeleteSelected}>
        <MenuIconSlot>
          <Trash2 className="size-3" />
        </MenuIconSlot>
        Delete
      </ContextMenuItem>
      {actions.actionError && (
        <>
          <ContextMenuSeparator />
          <div className="px-2 py-1.5 text-sm text-destructive">
            {actions.actionError}
          </div>
        </>
      )}
    </ContextMenuContent>
  );
}
