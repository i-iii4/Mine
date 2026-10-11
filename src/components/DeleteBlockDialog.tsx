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
import {
  DeleteMediaPreviewGrid,
  deletePlanErrorDescription,
  deleteWindowDescription,
} from "@/components/DeleteWindowParts";
import type { DeleteBlockPlan } from "@/types";

interface DeleteBlockDialogProps {
  /** Asked for: the window shows once the plan or its error is here. */
  open: boolean;
  vaultPath: string;
  thumbsRootPath?: string;
  plan: DeleteBlockPlan | null;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onKeepMedia: () => void;
  onDeleteMedia: () => void;
}

/// `Delete element?`: the element goes to the Trash, with the media only it
/// uses unless `Keep media` (DESIGN_SYSTEM.md, «Окна», «Тексты окон»). The
/// window closes on a press, before the command answers; a failure shows as
/// a notice of the tab (`App.tsx`, `performDeleteBlock`).
export function DeleteBlockDialog({
  open,
  vaultPath,
  thumbsRootPath,
  plan,
  error,
  onOpenChange,
  onKeepMedia,
  onDeleteMedia,
}: DeleteBlockDialogProps) {
  const unusedCount = plan?.unused_media.length ?? 0;
  const sharedCount = plan?.shared_media.length ?? 0;
  const hasUnusedMedia = unusedCount > 0;
  const description = error
    ? deletePlanErrorDescription(error)
    : deleteWindowDescription({ kind: "element" }, unusedCount, sharedCount);
  // The window waits for its plan, read from the index at once, and opens
  // already at its width: no "checking" state that widens when the media
  // arrive (user's decision of 11.10.2026).
  const ready = plan !== null || error !== null;

  return (
    <AlertDialog open={open && ready} onOpenChange={onOpenChange}>
      {/* A question, unless it shows the media that go with the element. */}
      <AlertDialogContent widthRole={hasUnusedMedia ? "content" : "question"}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete element?
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {plan && hasUnusedMedia ? (
          <DeleteMediaPreviewGrid
            media={plan.unused_media}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            posterSlug={() => plan.slug}
          />
        ) : null}
        {/* One row at the bottom right, as in every window: Cancel, the
            alternative, and Delete, the one primary, last. */}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {hasUnusedMedia && (
            <AlertDialogAction variant="secondary" onClick={onKeepMedia}>
              Keep media
            </AlertDialogAction>
          )}
          <AlertDialogAction
            variant="destructive"
            disabled={!plan || Boolean(error)}
            onClick={onDeleteMedia}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
