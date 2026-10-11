import { useEffect, useState } from "react";

import type { RenameBlockError } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogCancel, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MODAL_ERROR_CLASS } from "@/components/ui/modal-window";

interface RenameBlockDialogProps {
  open: boolean;
  currentSlug: string | null;
  onOpenChange: (open: boolean) => void;
  onRename: (currentSlug: string, newStem: string) => Promise<void>;
}

export function renameErrorMessage(error: RenameBlockError): string {
  switch (error.kind) {
    case "name_taken":
      return `A file named "${error.requested}.md" already exists.`;
    case "invalid_filename":
      return error.reason;
    case "block_not_found":
      return `Element "${error.slug}" no longer exists.`;
    case "no_vault":
      return "No space is currently open.";
    case "internal":
      return error.message;
  }
}

export function RenameBlockDialog({
  open,
  currentSlug,
  onOpenChange,
  onRename,
}: RenameBlockDialogProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<RenameBlockError | null>(null);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
      return;
    }
    setValue(currentSlug ?? "");
    setError(null);
  }, [currentSlug, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>
            Change the Markdown filename without changing the article title.
          </DialogDescription>
        </DialogHeader>

        {/* The field opens on the current name; the extension stands after
            it, as Finder shows it, so the final name reads in one line. */}
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Filename"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              spellCheck={false}
              disabled={submitting}
              onKeyDown={(event) => {
                if (event.key === "Enter" && currentSlug && value.trim()) {
                  event.preventDefault();
                  void (async () => {
                    try {
                      setSubmitting(true);
                      setError(null);
                      await onRename(currentSlug, value);
                      onOpenChange(false);
                    } catch (rawError) {
                      setError(rawError as RenameBlockError);
                    } finally {
                      setSubmitting(false);
                    }
                  })();
                }
              }}
            />
            <span className="shrink-0 text-base text-muted-foreground">.md</span>
          </div>

          {error && (
            <p className={MODAL_ERROR_CLASS}>{renameErrorMessage(error)}</p>
          )}
        </div>

        <DialogFooter>
          <DialogCancel disabled={submitting}>Cancel</DialogCancel>
          <Button
            onClick={async () => {
              if (!currentSlug || !value.trim()) {
                return;
              }
              try {
                setSubmitting(true);
                setError(null);
                await onRename(currentSlug, value);
                onOpenChange(false);
              } catch (rawError) {
                setError(rawError as RenameBlockError);
              } finally {
                setSubmitting(false);
              }
            }}
            disabled={!currentSlug || !value.trim() || submitting}
          >
            {submitting ? "Renaming…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
