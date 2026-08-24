import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { useGroupSelectionMenuActions } from "@/hooks/useGroupSelectionMenuActions";
import type { LightBlock, TagCount } from "@/types";
import { selectedElementCountLabel } from "@/lib/groupSelection";
import { DeleteSelectedCardsDialog } from "./DeleteSelectedCardsDialog";
import {
  BatchCollectionPicker,
  COLLECTION_PICKER_CONTENT_CLASS,
} from "./CollectionPicker";

interface GroupSelectionCardMenuProps {
  selectedBlocks: readonly LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  openRequestSequence?: number;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
  onMergeSelectedBlocks: () => void;
  onClearSelection: () => void;
}

export function GroupSelectionCardMenu({
  selectedBlocks,
  tags,
  currentTag,
  openRequestSequence = 0,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onDeleteSelectedBlocks,
  onMergeSelectedBlocks,
  onClearSelection,
}: GroupSelectionCardMenuProps) {
  const actions = useGroupSelectionMenuActions({
    selectedBlocks,
    currentTag,
    onLoadBlockTags,
    onBatchSetTag,
    onCreateAndAssignBatch,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const connectTriggerRef = useRef<HTMLDivElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const lastOpenRequestSequenceRef = useRef(0);

  const updateMenuOpen = useCallback((open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
    if (!open) {
      actions.setConnectOpen(false);
    }
  }, [actions]);

  useEffect(() => {
    if (openRequestSequence <= lastOpenRequestSequenceRef.current) return;
    lastOpenRequestSequenceRef.current = openRequestSequence;
    updateMenuOpen(!menuOpenRef.current);
  }, [openRequestSequence, updateMenuOpen]);

  const handleDisconnectFromCollection = () => {
    actions.disconnectFromCurrentCollection();
    updateMenuOpen(false);
    onClearSelection();
  };

  const handleConfirmDelete = async () => {
    await onDeleteSelectedBlocks(actions.selectedSlugs);
    updateMenuOpen(false);
    onClearSelection();
  };

  const handleMerge = () => {
    updateMenuOpen(false);
    onMergeSelectedBlocks();
  };

  if (selectedBlocks.length === 0) return null;

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={updateMenuOpen}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-xs"
            className="pointer-events-none absolute right-2 top-2 z-[7] opacity-0 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
            data-feed-grid-batch-menu-trigger=""
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-feed-grid-batch-menu=""
        >
          <div
            className="px-2 py-1.5 font-mono text-sm text-muted-foreground"
            data-feed-grid-batch-menu-count=""
          >
            {selectedElementCountLabel(selectedBlocks.length)}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuSub open={actions.connectOpen} onOpenChange={actions.setConnectOpen}>
            <DropdownMenuSubTrigger ref={connectTriggerRef}>
              <MenuIconSlot>
                <Plus className="size-3" />
              </MenuIconSlot>
              Connect
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS}>
              <BatchCollectionPicker
                selectedSlugs={actions.selectedSlugs}
                tags={tags}
                tagLookup={actions.tagLookup}
                onBatchSetTag={actions.batchSetTag}
                onCreateAndAssign={actions.createAndAssignBatch}
                onRequestClose={() => {
                  actions.setConnectOpen(false);
                  requestAnimationFrame(() => connectTriggerRef.current?.focus());
                }}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {currentTag && (
            <DropdownMenuItem variant="detach" onSelect={handleDisconnectFromCollection}>
              <MenuIconSlot>
                <Unlink className="size-3" />
              </MenuIconSlot>
              Disconnect
            </DropdownMenuItem>
          )}
          {selectedBlocks.length >= 2 && (
            <DropdownMenuItem onSelect={handleMerge}>
              <MenuIconSlot />
              Merge
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            onSelect={(event) => {
              event.preventDefault();
              setDeleteOpen(true);
            }}
          >
            <MenuIconSlot>
              <Trash2 className="size-3" />
            </MenuIconSlot>
            Delete
          </DropdownMenuItem>
          {actions.actionError && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-sm text-destructive">
                {actions.actionError}
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteSelectedCardsDialog
        open={deleteOpen}
        selectedCount={selectedBlocks.length}
        onOpenChange={setDeleteOpen}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
