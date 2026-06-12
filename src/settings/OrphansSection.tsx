import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  deleteOrphanMedia,
  getVaultPath,
  listOrphanMedia,
  promoteOrphanMedia,
} from "@/lib/commands";
import { mediaUrl } from "@/lib/assets";
import { formatBytes } from "@/lib/formatBytes";
import type { OrphanMedia } from "@/types";

// Mirrors preview_plan::IMAGE_EXTS — extensions the asset protocol can render
// directly as an <img> preview. Everything else gets a placeholder slot.
const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "avif",
]);

function fileExt(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

type BatchAction = "promote" | "delete";

export function OrphansSection() {
  const [orphans, setOrphans] = useState<OrphanMedia[]>([]);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<BatchAction | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [items, path] = await Promise.all([listOrphanMedia(), getVaultPath()]);
      setOrphans(items);
      setVaultPath(path);
      setSelected((previous) => {
        const names = new Set(items.map((item) => item.file_name));
        return new Set([...previous].filter((name) => names.has(name)));
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const allSelected = orphans.length > 0 && selected.size === orphans.length;
  const selectAllState: boolean | "indeterminate" = allSelected
    ? true
    : selected.size > 0
      ? "indeterminate"
      : false;

  const selectedNames = useMemo(() => [...selected], [selected]);

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(orphans.map((item) => item.file_name)));
  };

  const toggleOne = (fileName: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(fileName)) {
        next.delete(fileName);
      } else {
        next.add(fileName);
      }
      return next;
    });
  };

  const handlePromote = async () => {
    setWorking("promote");
    setSummary(null);
    setError(null);
    try {
      const result = await promoteOrphanMedia(selectedNames);
      setSummary(`Converted ${result.created.length}, skipped ${result.skipped.length}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
    }
  };

  const handleDelete = async () => {
    setConfirmDeleteOpen(false);
    setWorking("delete");
    setSummary(null);
    setError(null);
    try {
      const result = await deleteOrphanMedia(selectedNames);
      setSummary(`Deleted ${result.deleted.length}, skipped ${result.skipped.length}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
    }
  };

  return (
    <section className="flex flex-col gap-s3">
      <div className="flex items-center justify-between gap-s2">
        <h1 className="text-lg font-semibold">
          Orphans{" "}
          <span className="font-normal text-muted-foreground">{orphans.length}</span>
        </h1>
        <Button variant="ghost" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Media files in the space root that no element references.
      </p>

      {orphans.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No orphan media</p>
      ) : (
        <div className="flex flex-col rounded-1 border border-border">
          <div className="flex h-8 items-center gap-s2 border-b border-border px-3">
            <Checkbox
              aria-label="Select all orphans"
              checked={selectAllState}
              onCheckedChange={toggleAll}
            />
            <span className="text-sm text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </div>
          <ul className="flex max-h-[320px] flex-col overflow-y-auto p-1">
            {orphans.map((item) => {
              const isImage = IMAGE_EXTS.has(fileExt(item.file_name));
              return (
                <li key={item.file_name}>
                  <label className="flex h-10 cursor-pointer items-center gap-s2 rounded-1 px-2 hover:bg-active">
                    <Checkbox
                      aria-label={`Select ${item.file_name}`}
                      checked={selected.has(item.file_name)}
                      onCheckedChange={() => toggleOne(item.file_name)}
                    />
                    {isImage && vaultPath ? (
                      <img
                        src={mediaUrl(vaultPath, item.file_name)}
                        alt=""
                        loading="lazy"
                        className="size-8 shrink-0 rounded-[2px] bg-component-fill object-cover"
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className="size-8 shrink-0 rounded-[2px] bg-component-fill"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-base">{item.file_name}</span>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {formatBytes(item.size_bytes)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {selected.size > 0 && (
        <div className="flex items-center gap-s2">
          <Button
            variant="default"
            disabled={working !== null}
            onClick={() => void handlePromote()}
          >
            {working === "promote" ? "Working…" : "Convert to Elements"}
          </Button>
          <Button
            variant="destructive"
            disabled={working !== null}
            onClick={() => setConfirmDeleteOpen(true)}
          >
            {working === "delete" ? "Working…" : "Delete"}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} {selected.size === 1 ? "file" : "files"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Files are moved to the system Trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
