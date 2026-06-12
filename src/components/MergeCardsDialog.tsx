import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { thumbnailUrl } from "@/lib/assets";
import { getNavigationLabel } from "@/lib/displayTitle";
import { cn } from "@/lib/utils";
import type { LightBlock } from "@/types";
import { CardReferenceRow } from "./CardReferenceRow";
import type { MicroPreviewModel } from "./MicroPreviewThumbnail";

interface MergeCardsDialogProps {
  open: boolean;
  selectedBlocks: readonly LightBlock[];
  thumbsRootPath?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (orderedSlugs: string[]) => Promise<void>;
}

export function MergeCardsDialog({
  open,
  selectedBlocks,
  thumbsRootPath,
  onOpenChange,
  onConfirm,
}: MergeCardsDialogProps) {
  const [orderedSlugs, setOrderedSlugs] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockBySlug = useMemo(
    () => new Map(selectedBlocks.map((block) => [block.slug, block])),
    [selectedBlocks],
  );
  const orderedBlocks = useMemo(
    () => orderedSlugs.flatMap((slug) => blockBySlug.get(slug) ?? []),
    [blockBySlug, orderedSlugs],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!open) return;
    setOrderedSlugs(selectedBlocks.map((block) => block.slug));
    setError(null);
    setSubmitting(false);
  }, [open, selectedBlocks]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderedSlugs((current) => {
      const oldIndex = current.indexOf(String(active.id));
      const newIndex = current.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
  };

  const handleConfirm = async () => {
    if (orderedSlugs.length < 2) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(orderedSlugs);
      onOpenChange(false);
    } catch (err) {
      setError(mergeErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mergeDialogTitle(orderedBlocks.length)}</DialogTitle>
          <DialogDescription>
            Drag cards to set the merge order.
          </DialogDescription>
        </DialogHeader>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedSlugs} strategy={verticalListSortingStrategy}>
            <div className="max-h-[min(60vh,28rem)] overflow-y-auto pr-1" data-merge-cards-list="">
              <div className="flex flex-col gap-1">
                {orderedBlocks.map((block) => (
                  <MergeCardsDialogRow
                    key={block.slug}
                    block={block}
                    thumbsRootPath={thumbsRootPath}
                  />
                ))}
              </div>
            </div>
          </SortableContext>
        </DndContext>

        {error && (
          <p className="rounded-1 border border-destructive bg-background px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={submitting || orderedSlugs.length < 2}
            onClick={() => {
              void handleConfirm();
            }}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function mergeDialogTitle(count: number): string {
  return `Merge ${count} ${count === 1 ? "element" : "elements"}`;
}

function MergeCardsDialogRow({
  block,
  thumbsRootPath,
}: {
  block: LightBlock;
  thumbsRootPath?: string;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.slug });
  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} data-merge-cards-row="">
      <CardReferenceRow
        label={getNavigationLabel(block)}
        preview={previewFromLightBlock(block, thumbsRootPath)}
        leadingSlot={
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={`Reorder ${getNavigationLabel(block)}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-1 text-muted-foreground outline-0 outline-transparent hover:text-foreground focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        }
        className={cn(isDragging && "opacity-60")}
      />
    </div>
  );
}

function mergeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "kind" in error) {
    const kind = String((error as { kind: unknown }).kind);
    if (kind === "too_few_cards") return "Select at least two elements.";
    if (kind === "duplicate_slug") return "The merge list contains the same element twice.";
    if (kind === "block_not_found") return "One of the selected elements no longer exists.";
    if (kind === "block_not_mergeable") return "Channels cannot be merged.";
    if ("message" in error && typeof (error as { message: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
    return `Merge failed: ${kind}`;
  }
  return String(error);
}

function previewFromLightBlock(
  block: LightBlock,
  thumbsRootPath?: string,
): MicroPreviewModel | null {
  if (!thumbsRootPath) return null;
  return {
    slug: block.slug,
    url: thumbnailUrl(thumbsRootPath, block.slug),
    text: block.card_kind === "article",
    hasThumb: true,
  };
}
