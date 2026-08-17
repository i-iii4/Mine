// What is about to become a space, stated before it does.
//
// Choosing a folder is recursive and not undoable, and `~/Documents` is one
// misclick away — so the count comes first and the sentence says plainly that
// the files are read as they are. Split out from the picker so the design
// system can draw it: nobody should have to point the app at a folder full of
// documents to review this screen. See SPEC_ONBOARDING.md О12.

import { Button } from "@/components/ui/button";
import type { FolderPreview } from "@/types";

function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function describeContents(preview: FolderPreview): string {
  const parts: string[] = [];
  if (preview.markdown_files > 0) {
    parts.push(`${preview.markdown_files} note${preview.markdown_files === 1 ? "" : "s"}`);
  }
  if (preview.media_files > 0) {
    parts.push(`${preview.media_files} media file${preview.media_files === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "some files";
  return parts.join(" and ");
}

interface FolderConfirmationProps {
  path: string;
  preview: FolderPreview;
  loading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onChooseAnother: () => void;
}

export function FolderConfirmation({
  path,
  preview,
  loading = false,
  error = null,
  onConfirm,
  onChooseAnother,
}: FolderConfirmationProps) {
  return (
    <div
      className="flex size-full min-h-80 items-center justify-center bg-background"
      data-folder-confirmation=""
    >
      <div className="flex max-w-md flex-col items-start gap-6 text-left">
        <h1 className="text-lg font-semibold text-foreground">
          Open “{folderName(path)}” as a space?
        </h1>
        <p className="text-base text-muted-foreground">
          It already contains {describeContents(preview)}. They will appear as
          cards. Mine reads them as they are and does not change their contents.
        </p>
        <p className="font-mono text-sm text-muted-foreground">{path}</p>
        <div className="flex items-center gap-2">
          <Button disabled={loading} onClick={onConfirm}>
            {loading ? "Opening…" : "Open as space"}
          </Button>
          <Button variant="secondary" disabled={loading} onClick={onChooseAnother}>
            Choose another
          </Button>
        </div>
        {error && <p className="text-base text-destructive">{error}</p>}
      </div>
    </div>
  );
}
