// The first screen: choosing where a space lives.
//
// Three things are worth saying before the first decision, because they are the
// whole product: cards are files, collections are ordinary notes, nothing goes
// to a server. And choosing must be two actions, not one — someone who just
// wants to try Mine should not have to invent and create a folder first.
//
// A folder that already has files gets a confirmation, because picking the
// wrong one turns an entire archive into a space and there is no undo.
// See SPEC_ONBOARDING.md О9–О13.

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { previewVaultFolder, selectVault } from "@/lib/commands";
import { Button } from "@/components/ui/button";
import type { FolderPreview, VaultOpenResult } from "@/types";

interface VaultPickerProps {
  onVaultSelected: (path: string) => void;
}

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

export function VaultPicker({ onVaultSelected }: VaultPickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VaultOpenResult | null>(null);
  const [pending, setPending] = useState<{ path: string; preview: FolderPreview } | null>(null);

  const openSpace = async (path: string) => {
    setLoading(true);
    try {
      setResult(await selectVault(path));
      onVaultSelected(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const choose = async () => {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;

    try {
      const preview = await previewVaultFolder(selected);
      const isEmpty =
        preview.markdown_files === 0 &&
        preview.media_files === 0 &&
        preview.other_files === 0;
      if (isEmpty) {
        await openSpace(selected);
        return;
      }
      setPending({ path: selected, preview });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (pending) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">
            Open “{folderName(pending.path)}” as a space?
          </h1>
          <p className="text-base text-muted-foreground">
            It already contains {describeContents(pending.preview)}. They will
            appear as cards. Mine reads them as they are and does not change
            their contents.
          </p>
          <p className="font-mono text-sm text-muted-foreground">{pending.path}</p>
          <div className="flex items-center gap-2">
            <Button disabled={loading} onClick={() => void openSpace(pending.path)}>
              {loading ? "Opening…" : "Open as space"}
            </Button>
            <Button variant="secondary" disabled={loading} onClick={() => setPending(null)}>
              Choose another
            </Button>
          </div>
          {error && <p className="text-base text-destructive">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <h1 className="text-lg font-semibold text-foreground">Mine</h1>

        <div className="grid gap-1 text-base text-muted-foreground">
          <p>Every card is a file in a folder you choose.</p>
          <p>Every collection is an ordinary note you can open elsewhere.</p>
          <p>Nothing is uploaded anywhere.</p>
        </div>

        {result ? (
          <div className="rounded-1 bg-accent px-6 py-4">
            <p className="text-base text-muted-foreground">
              Loaded{" "}
              <span className="font-semibold text-foreground">{result.indexed}</span>{" "}
              indexed blocks
              {result.migration_required && (
                <span className="text-muted-foreground">, preparing local library…</span>
              )}
              {!result.migration_required && result.bootstrapped_from_legacy && (
                <span className="text-muted-foreground">
                  , local snapshot restored from legacy cache…
                </span>
              )}
              {result.sync_in_progress && (
                <span className="text-muted-foreground">, syncing in background…</span>
              )}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button onClick={() => void choose()} disabled={loading}>
              {loading ? "Opening…" : "Choose folder"}
            </Button>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          macOS will ask for permission to that folder — that is how it grants
          Mine access to your files.
        </p>

        {error && <p className="text-base text-destructive">{error}</p>}
      </div>
    </div>
  );
}
