import { useState } from "react";
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
import { selectedElementCountLabel } from "@/lib/groupSelection";

interface DeleteSelectedCardsDialogProps {
  open: boolean;
  selectedCount: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

/// Confirmation for deleting a whole selection, shared by the ⌘K card menu and
/// the right-click context menu.
///
/// A failed delete keeps the dialog open and states the reason here rather than
/// in the menu that opened it: by that point the menu may already be gone, and
/// an error with no visible home is an error the user never reads.
export function DeleteSelectedCardsDialog({
  open,
  selectedCount,
  onOpenChange,
  onConfirm,
}: DeleteSelectedCardsDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
      setError(null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>Delete selected elements?</AlertDialogTitle>
          <AlertDialogDescription>
            This will delete {selectedElementCountLabel(selectedCount)}. Media files stay in the vault.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <div className="text-sm text-destructive" data-delete-selected-error="">
            {error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
