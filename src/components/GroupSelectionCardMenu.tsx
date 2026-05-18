import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import type { LightBlock, TagCount } from "@/types";
import {
  patchTagLookup,
  scheduleAfterOptimisticUiUpdate,
  selectedCardCountLabel,
} from "@/lib/groupSelection";
import { BatchCollectionPicker } from "./CollectionPicker";

interface GroupSelectionCardMenuProps {
  selectedBlocks: readonly LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  openRequestSequence?: number;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
  onClearSelection: () => void;
}

function MenuIconSlot({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-3 shrink-0 items-center justify-center"
      data-card-menu-icon-slot=""
    >
      {children}
    </span>
  );
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
  onClearSelection,
}: GroupSelectionCardMenuProps) {
  const selectedSlugs = useMemo(
    () => selectedBlocks.map((block) => block.slug),
    [selectedBlocks],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const connectTriggerRef = useRef<HTMLDivElement>(null);
  const [tagLookup, setTagLookup] = useState<Map<string, string[]>>(new Map());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastOpenRequestSequenceRef = useRef(0);

  const updateMenuOpen = useCallback((open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
    if (!open) {
      setConnectOpen(false);
    }
  }, []);

  useEffect(() => {
    if (openRequestSequence <= lastOpenRequestSequenceRef.current) return;
    lastOpenRequestSequenceRef.current = openRequestSequence;
    updateMenuOpen(!menuOpenRef.current);
  }, [openRequestSequence, updateMenuOpen]);

  useEffect(() => {
    if (!connectOpen || selectedSlugs.length === 0) return;
    let cancelled = false;
    void onLoadBlockTags(selectedSlugs)
      .then((lookup) => {
        if (!cancelled) {
          setTagLookup(lookup);
          setActionError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectOpen, onLoadBlockTags, selectedSlugs]);

  const handleBatchSetTag = (
    targetSlugs: string[],
    tag: string,
    connected: boolean,
  ) => {
    if (targetSlugs.length === 0) return;
    setTagLookup((current) => patchTagLookup(current, targetSlugs, tag, connected));
    setActionError(null);
    scheduleAfterOptimisticUiUpdate(() => {
      void Promise.resolve(onBatchSetTag(targetSlugs, tag, connected)).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    });
  };

  const handleCreateAndAssignBatch = (tag: string) => {
    setTagLookup((current) => patchTagLookup(current, selectedSlugs, tag, true));
    setActionError(null);
    scheduleAfterOptimisticUiUpdate(() => {
      void Promise.resolve(onCreateAndAssignBatch(tag, selectedSlugs)).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    });
  };

  const handleDisconnectFromCollection = () => {
    if (!currentTag) return;
    handleBatchSetTag(selectedSlugs, currentTag, false);
    updateMenuOpen(false);
    onClearSelection();
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteSelectedBlocks(selectedSlugs);
      setActionError(null);
      setDeleteOpen(false);
      updateMenuOpen(false);
      onClearSelection();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
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
            {selectedCardCountLabel(selectedBlocks.length)}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuSub open={connectOpen} onOpenChange={setConnectOpen}>
            <DropdownMenuSubTrigger ref={connectTriggerRef}>
              <MenuIconSlot>
                <Plus className="size-3" />
              </MenuIconSlot>
              Connect
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="flex w-72 max-h-80 flex-col overflow-hidden p-0">
              <BatchCollectionPicker
                selectedSlugs={selectedSlugs}
                tags={tags}
                tagLookup={tagLookup}
                onBatchSetTag={handleBatchSetTag}
                onCreateAndAssign={handleCreateAndAssignBatch}
                onRequestClose={() => {
                  setConnectOpen(false);
                  requestAnimationFrame(() => connectTriggerRef.current?.focus());
                }}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {currentTag && (
            <DropdownMenuItem onSelect={handleDisconnectFromCollection}>
              <MenuIconSlot />
              Disconnect
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            onSelect={(event) => {
              event.preventDefault();
              setDeleteOpen(true);
            }}
          >
            <MenuIconSlot />
            Delete
          </DropdownMenuItem>
          {actionError && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-sm text-destructive">
                {actionError}
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>Delete selected cards?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete {selectedCardCountLabel(selectedBlocks.length)}. Media files stay in the vault.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
