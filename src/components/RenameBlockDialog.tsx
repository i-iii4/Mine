import { useEffect, useMemo, useState } from "react";

import type { RenameBlockError } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface RenameBlockDialogProps {
  open: boolean;
  currentSlug: string | null;
  onOpenChange: (open: boolean) => void;
  onRename: (currentSlug: string, newStem: string) => Promise<void>;
}

function renameErrorMessage(error: RenameBlockError): string {
  switch (error.kind) {
    case "name_taken":
      return `A file named "${error.requested}.md" already exists.`;
    case "invalid_filename":
      return error.reason;
    case "block_not_found":
      return `Block "${error.slug}" no longer exists.`;
    case "no_vault":
      return "No vault is currently open.";
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

  const previewName = useMemo(() => {
    const trimmed = value.trim();
    return trimmed ? `${trimmed}.md` : "—";
  }, [value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>
            Change the Markdown filename without changing the article title.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">Current</div>
            <div className="font-mono text-sm text-muted-foreground">
              {currentSlug ? `${currentSlug}.md` : "—"}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="rename-block-input">
              Filename
            </label>
            <Input
              id="rename-block-input"
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
            <div className="text-sm text-muted-foreground">
              Final file: <span className="font-mono">{previewName}</span>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{renameErrorMessage(error)}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
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
