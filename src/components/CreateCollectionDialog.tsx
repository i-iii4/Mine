import { useEffect, useState } from "react";
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MODAL_ERROR_CLASS } from "@/components/ui/modal-window";
import { useCollectionNameRefusal, type CollectionNameCheck } from "@/hooks/useCollectionNameRefusal";
import { nameRefusal } from "@/lib/commands";
import { errorMessage } from "@/lib/errorMessage";

/** The description of the window that names a new collection: hidden, for
 *  the screen reader only. The title already says what is typed; the old
 *  visible text pointed at the sidebar, and this window shows exactly when
 *  the sidebar is closed (DESIGN_SYSTEM.md, «Тексты окон»). */
export const NEW_COLLECTION_DESCRIPTION = "Name the new collection.";

/** The Create button while the collection is being made (DESIGN_SYSTEM.md,
 *  «Окна», «Ход действия»). */
export const CREATING_LABEL = "Creating…";

interface CreateCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Makes the collection; a refusal rejects, and the window shows why. */
  onCreate: (name: string) => Promise<unknown>;
  /** The check of the name as it is typed, the one every place a collection
   *  is named asks (`check_collection_name`). */
  onCheckName?: CollectionNameCheck;
  /** The name the field opens with: what was typed where the window was
   *  asked for (the collection switcher's search). */
  initialName?: string;
}

/**
 * The one window that names a new collection (SPEC_DEEP_AUDIT.md, Е6.2):
 * ⇧⌘N and `+` with the sidebar closed, and `Create collection` of the
 * collection switcher. With the sidebar open the name is typed into the list
 * itself, in the row the collection will occupy.
 *
 * The name is checked as it is typed and the reason stands under the field;
 * a creation the app refuses keeps the window open with its reason, and the
 * window closes only after a creation that was made.
 */
export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreate,
  onCheckName,
  initialName = "",
}: CreateCollectionDialogProps) {
  const [name, setName] = useState(initialName);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
    } else {
      setName("");
    }
    setFailure(null);
    setCreating(false);
  }, [initialName, open]);

  const trimmed = name.trim().replace(/\s+/g, " ");
  const refusal = useCollectionNameRefusal(trimmed, onCheckName);
  const reason = failure ?? refusal;
  const canCreate = trimmed.length > 0 && refusal === null && !creating;

  const submit = async () => {
    if (!canCreate) return;
    setCreating(true);
    setFailure(null);
    try {
      await onCreate(trimmed);
    } catch (error) {
      setFailure(nameRefusal(error) ?? errorMessage(error));
      setCreating(false);
      return;
    }
    setCreating(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The window waits for its answer, as every window that is working.
        if (!next && creating) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription className="sr-only">{NEW_COLLECTION_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input
              autoFocus
              value={name}
              placeholder="Collection name"
              aria-label="Collection name"
              aria-invalid={reason !== null || undefined}
              onChange={(event) => {
                setName(event.target.value);
                setFailure(null);
              }}
            />
            {reason !== null && (
              <p role="alert" className={MODAL_ERROR_CLASS}>
                {reason}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogCancel disabled={creating}>Cancel</DialogCancel>
            <Button type="submit" disabled={!canCreate}>
              {creating ? CREATING_LABEL : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
