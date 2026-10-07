import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BatchCollectionPicker,
  COLLECTION_PICKER_CONTENT_CLASS,
} from "./CollectionPicker";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { ChromeActions } from "./ChromeRow";
import { commandById } from "@/lib/commandRegistry";
import type { LightBlock, TagCount } from "@/types";
import {
  patchTagLookup,
  scheduleAfterOptimisticUiUpdate,
  selectedElementCountLabel,
} from "@/lib/groupSelection";

interface GroupSelectionCommandsProps {
  selectedBlocks: LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
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
  onDeleteSelectedBlocks,
  onMergeSelectedBlocks,
  onClearSelection,
}: GroupSelectionCommandsProps) {
  const selectedSlugs = useMemo(
    () => selectedBlocks.map((block) => block.slug),
    [selectedBlocks],
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [tagLookup, setTagLookup] = useState<Map<string, string[]>>(new Map());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const reportActionError = useCallback((err: unknown) => {
    setActionError(err instanceof Error ? err.message : String(err));
  }, []);

  const handleBatchSetTag = (
    targetSlugs: string[],
    tag: string,
    connected: boolean,
  ) => {
    if (targetSlugs.length === 0) return;
    setTagLookup((current) => patchTagLookup(current, targetSlugs, tag, connected));
    setActionError(null);
    scheduleAfterOptimisticUiUpdate(() => {
      void Promise.resolve(onBatchSetTag(targetSlugs, tag, connected)).catch(reportActionError);
    });
  };

  const handleCreateAndAssignBatch = (tag: string) => {
    setTagLookup((current) => patchTagLookup(current, selectedSlugs, tag, true));
    setActionError(null);
    scheduleAfterOptimisticUiUpdate(() => {
      void Promise.resolve(onCreateAndAssignBatch(tag, selectedSlugs)).catch(reportActionError);
    });
  };

  const handleRemoveFromCollection = () => {
    if (!currentTag) return;
    handleBatchSetTag(selectedSlugs, currentTag, false);
    onClearSelection();
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteSelectedBlocks(selectedSlugs);
      setActionError(null);
      setDeleteOpen(false);
      onClearSelection();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
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
          row's min-content) while the commands keep their size; the row
          scrolls only once the commands alone outgrow it. The pads live on
          the scrolled content, not the scrollport: a scroll container's end
          padding never renders past its content. */}
      <div className="h-full max-w-full overflow-x-auto overflow-y-hidden">
        <div className="flex h-full w-full min-w-min items-center gap-1 pl-[var(--main-secondary-pad-x,0.5rem)]">
          <div
            className="w-0 min-w-0 flex-1 truncate px-2 font-mono text-sm text-muted-foreground"
            data-feed-selection-count=""
          >
            {`${selectedElementCountLabel(selectedBlocks.length)} selected`}
          </div>

          <ChromeActions data-feed-selection-actions="">
            <DropdownMenu open={connectOpen} onOpenChange={setConnectOpen} modal={false}>
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
              <DropdownMenuContent className={COLLECTION_PICKER_CONTENT_CLASS} align="center">
                <BatchCollectionPicker
                  selectedSlugs={selectedSlugs}
                  tags={tags}
                  tagLookup={tagLookup}
                  onBatchSetTag={handleBatchSetTag}
                  onCreateAndAssign={handleCreateAndAssignBatch}
                />
              </DropdownMenuContent>
            </DropdownMenu>

            {currentTag && (
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0 text-detach"
                onClick={() => {
                  void handleRemoveFromCollection();
                }}
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

            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  className="shrink-0"
                >
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader className="place-items-start text-left">
                  <AlertDialogTitle>Delete selected elements?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete {selectedElementCountLabel(selectedBlocks.length)}. Media files stay in the vault.
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

            <ChromeCloseButton
              label="Clear selection"
              shortcut={commandById("clear-selection").combo}
              onClick={onClearSelection}
            />
          </ChromeActions>
        </div>
      </div>
      {actionError && (
        <p className="absolute left-1/2 top-full z-40 mt-2 -translate-x-1/2 rounded-1 border border-destructive bg-background px-3 py-1 text-sm text-destructive">
          {actionError}
        </p>
      )}
    </div>
  );
}
