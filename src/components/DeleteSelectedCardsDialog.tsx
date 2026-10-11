import { useCallback, useEffect, useState } from "react";
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
import { MODAL_ERROR_CLASS } from "@/components/ui/modal-window";
import {
  DeleteMediaPreviewGrid,
  deletePlanErrorDescription,
  deleteWindowDescription,
} from "@/components/DeleteWindowParts";
import type { DeleteBlockMedia, DeleteBlocksPlan } from "@/types";

/** Which button of the window is deleting: with the media, or keeping them. */
export type DeleteSelectionPending = "delete" | "keep-media";

/** The selection asked to go, as it stood when asked. */
export interface DeleteSelectionRequest {
  slugs: string[];
  /** Tells one request from the next, so a window never shows an old plan. */
  sequence: number;
}

/** Deletes the cards and, when asked, the media the plan offered. */
export type DeleteSelectionAction = (
  slugs: string[],
  deleteUnusedMedia: boolean,
  offeredMedia: DeleteBlockMedia[],
) => Promise<void>;

/// The description when every selected element was already gone by the time
/// the plan was read: nothing is left to delete, and `Delete` is unavailable
/// (SPEC_GROUP_SELECTION.md, «Окно», decision of 11.10.2026).
export const NOTHING_LEFT_TO_DELETE = "The selected elements are no longer in the space.";

interface DeleteSelectedCardsDialogProps {
  /** Asked for: the window shows once the plan or its error is here. */
  open: boolean;
  vaultPath: string;
  thumbsRootPath?: string;
  plan: DeleteBlocksPlan | null;
  error: string | null;
  /** The pressed button while the deletion runs; null otherwise. */
  pending: DeleteSelectionPending | null;
  /** Why the last press deleted nothing; the window stays open with it. */
  deleteError: string | null;
  onOpenChange: (open: boolean) => void;
  onKeepMedia: () => void;
  onDelete: () => void;
}

/// `Delete selected elements?` (SPEC_GROUP_SELECTION.md, «Batch Delete»,
/// «Окно»): `Delete element?` for a selection. Unlike it, the window stays
/// open while the one atomic batch runs, the pressed button says
/// `Deleting…`, and a failure shows in the window above the buttons.
export function DeleteSelectedCardsDialog({
  open,
  vaultPath,
  thumbsRootPath,
  plan,
  error,
  pending,
  deleteError,
  onOpenChange,
  onKeepMedia,
  onDelete,
}: DeleteSelectedCardsDialogProps) {
  const unusedCount = plan?.unused_media.length ?? 0;
  const sharedCount = plan?.shared_media.length ?? 0;
  const hasUnusedMedia = unusedCount > 0;
  const nothingLeft = plan !== null && plan.slugs.length === 0;
  const description = error
    ? deletePlanErrorDescription(error)
    : nothingLeft
      ? NOTHING_LEFT_TO_DELETE
      : deleteWindowDescription(
        { kind: "selection", count: plan?.slugs.length ?? 0 },
        unusedCount,
        sharedCount,
      );
  // The window waits for its plan, read from the index at once, and opens
  // already at its width, as `Delete element?` (decision of 11.10.2026).
  const ready = plan !== null || error !== null;
  const busy = pending !== null;

  return (
    <AlertDialog
      open={open && ready}
      onOpenChange={(next) => {
        // The batch is running: Escape cannot take the window away from it.
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      {/* A question, unless it shows the media that go with the elements. */}
      <AlertDialogContent widthRole={hasUnusedMedia ? "content" : "question"}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete selected elements?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {plan && hasUnusedMedia ? (
          <DeleteMediaPreviewGrid
            media={plan.unused_media}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            posterSlug={(item) => item.referenced_by[0] ?? null}
          />
        ) : null}
        {deleteError && (
          <div className={MODAL_ERROR_CLASS} data-delete-selected-error="">
            {deleteError}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {hasUnusedMedia && (
            <AlertDialogAction
              variant="secondary"
              disabled={busy}
              onClick={(event) => {
                // The window waits for the batch; it closes on success.
                event.preventDefault();
                onKeepMedia();
              }}
            >
              {pending === "keep-media" ? "Deleting…" : "Keep media"}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            variant="destructive"
            disabled={busy || !plan || Boolean(error) || nothingLeft}
            onClick={(event) => {
              event.preventDefault();
              onDelete();
            }}
          >
            {pending === "delete" ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DeleteSelectionWindowProps {
  /** Asked for; a closed window keeps its plan while it leaves, so it leaves
   *  at the width it had. */
  open: boolean;
  /** The selection asked to go, as it stood when asked. One window per
   *  request: the feed keys it by `DeleteSelectionRequest.sequence`, so a
   *  new request never shows the last one's plan. */
  slugs: string[];
  vaultPath: string;
  thumbsRootPath?: string;
  onPrepare: (slugs: string[]) => Promise<DeleteBlocksPlan>;
  onDelete: DeleteSelectionAction;
  /** The window closed without deleting. */
  onClose: () => void;
  /** The batch went through: the window closes and the selection clears. */
  onDeleted: () => void;
}

/// The one group delete window of the feed (SPEC_GROUP_SELECTION.md, «Точки
/// входа»): reads the plan of its request, then runs the batch and keeps the
/// window until it answers.
export function DeleteSelectionWindow({
  open,
  slugs,
  vaultPath,
  thumbsRootPath,
  onPrepare,
  onDelete,
  onClose,
  onDeleted,
}: DeleteSelectionWindowProps) {
  const [plan, setPlan] = useState<DeleteBlocksPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DeleteSelectionPending | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    onPrepare(slugs)
      .then((next) => {
        if (!cancelled) setPlan(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [onPrepare, slugs]);

  const run = useCallback(
    async (deleteUnusedMedia: boolean) => {
      if (!plan || pending !== null) return;
      setPending(deleteUnusedMedia ? "delete" : "keep-media");
      setDeleteError(null);
      try {
        await onDelete(plan.slugs, deleteUnusedMedia, deleteUnusedMedia ? plan.unused_media : []);
        setPending(null);
        onDeleted();
      } catch (err) {
        setPending(null);
        setDeleteError(errorMessage(err));
      }
    },
    [onDelete, onDeleted, pending, plan],
  );

  return (
    <DeleteSelectedCardsDialog
      open={open}
      vaultPath={vaultPath}
      thumbsRootPath={thumbsRootPath}
      plan={plan}
      error={error}
      pending={pending}
      deleteError={deleteError}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onKeepMedia={() => {
        void run(false);
      }}
      // Delete takes the media the window offers; with none offered, no
      // media analysis runs, as for one element.
      onDelete={() => {
        void run(Boolean(plan?.unused_media.length));
      }}
    />
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
