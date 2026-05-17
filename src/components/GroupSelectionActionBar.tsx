import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { Plus, X } from "lucide-react";
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
import { BatchCollectionPicker } from "./CollectionPicker";
import type { LightBlock, TagCount } from "@/types";

interface GroupSelectionActionBarProps {
  selectedBlocks: LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
  onClearSelection: () => void;
}

function selectedCardCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} карточка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} карточки`;
  }
  return `${count} карточек`;
}

function patchLookup(
  lookup: ReadonlyMap<string, readonly string[]>,
  slugs: readonly string[],
  tag: string,
  connected: boolean,
): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const [slug, tags] of lookup) {
    next.set(slug, [...tags]);
  }
  for (const slug of slugs) {
    const current = new Set(next.get(slug) ?? []);
    if (connected) {
      current.add(tag);
    } else {
      current.delete(tag);
    }
    next.set(slug, [...current]);
  }
  return next;
}

export function GroupSelectionActionBar({
  selectedBlocks,
  tags,
  currentTag,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onDeleteSelectedBlocks,
  onClearSelection,
}: GroupSelectionActionBarProps) {
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

  const handleBatchSetTag = async (
    targetSlugs: string[],
    tag: string,
    connected: boolean,
  ) => {
    if (targetSlugs.length === 0) return;
    setTagLookup((current) => patchLookup(current, targetSlugs, tag, connected));
    try {
      await onBatchSetTag(targetSlugs, tag, connected);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateAndAssignBatch = async (tag: string) => {
    setTagLookup((current) => patchLookup(current, selectedSlugs, tag, true));
    try {
      await onCreateAndAssignBatch(tag, selectedSlugs);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveFromCollection = async () => {
    if (!currentTag) return;
    await handleBatchSetTag(selectedSlugs, currentTag, false);
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
      className="pointer-events-none absolute bottom-s3 left-1/2 z-40 max-w-[calc(100%-3rem)] -translate-x-1/2"
      data-feed-selection-action-bar=""
    >
      <div className="pointer-events-auto h-8 max-w-full overflow-x-auto overflow-y-hidden rounded-1 border border-border bg-accent px-1 text-foreground shadow-md">
        <div className="flex h-full min-w-max items-center gap-1">
          <div
            className="shrink-0 px-2 font-mono text-sm text-muted-foreground"
            data-feed-selection-count=""
          >
            {selectedCardCountLabel(selectedBlocks.length)}
          </div>

          <DropdownMenu open={connectOpen} onOpenChange={setConnectOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0"
              >
                <Plus className="size-3" />
                Connect
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="flex w-72 max-h-80 flex-col overflow-hidden p-0" align="center">
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
              className="shrink-0"
              onClick={() => {
                void handleRemoveFromCollection();
              }}
            >
              Disconnect
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

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear selection"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={onClearSelection}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {actionError && (
        <p className="pointer-events-auto mt-2 rounded-1 border border-destructive bg-background px-3 py-1 text-sm text-destructive">
          {actionError}
        </p>
      )}
    </div>
  );
}
