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

/** What a new collection is, said the same in both windows that name one:
 *  this and the collection switcher's `Create collection`. */
export const NEW_COLLECTION_DESCRIPTION =
  "The collection appears in the sidebar and can be filled by dragging elements onto it.";

interface CreateCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}

/**
 * Naming a new collection when the sidebar is closed.
 *
 * With the sidebar open the name is typed into the list itself, in the row the
 * collection will occupy — there is nothing better a dialog could do. Closed,
 * that row has nowhere to appear, and the command used to do nothing visible at
 * all.
 */
export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreate,
}: CreateCollectionDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) setName("");
  }, [open]);

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onCreate(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
          <DialogDescription>{NEW_COLLECTION_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          placeholder="Collection name"
          aria-label="Collection name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
        />
        <DialogFooter>
          <DialogCancel>Cancel</DialogCancel>
          <Button onClick={submit} disabled={!trimmed}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
