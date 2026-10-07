import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  listOrphanMedia,
  promoteOrphanMedia,
} from "@/lib/commands";
import { mediaUrl } from "@/lib/assets";
import { formatBytes } from "@/lib/formatBytes";
import type { OrphanMedia } from "@/types";
import { OpenSpaceSelect } from "./OpenSpaceSelect";
import { useOpenSpaces, type OpenSpace } from "./useOpenSpaces";

// Mirrors preview_plan::IMAGE_EXTS — extensions the asset protocol can render
// directly as an <img> preview. Everything else gets a placeholder slot.
const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "avif",
]);

function fileExt(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

const DESCRIPTION = "Media files in the space root that no element references.";

type BatchAction = "promote" | "delete";

export function OrphansSection() {
  const { spaces, current, choose, error } = useOpenSpaces();

  if (spaces === null || current === null) {
    return (
      <section className="flex flex-col gap-s3">
        <h1 className="text-base font-semibold">Orphans</h1>
        <p className="text-base text-muted-foreground">{DESCRIPTION}</p>
        {spaces !== null && (
          <p className="py-12 text-center text-base text-muted-foreground">
            {error ?? "Open a space to find its orphan media."}
          </p>
        )}
      </section>
    );
  }

  // Keyed by the space: choosing another one starts its list from scratch,
  // and an answer still in flight for the previous space lands nowhere.
  return (
    <SpaceOrphans
      key={current.vaultId}
      space={current}
      selector={<OpenSpaceSelect spaces={spaces} current={current} onChoose={choose} />}
    />
  );
}

function SpaceOrphans({ space, selector }: { space: OpenSpace; selector: ReactNode }) {
  const [orphans, setOrphans] = useState<OrphanMedia[]>([]);
  // The space the list was built for: every operation on it names that space.
  const [listSpace, setListSpace] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<BatchAction | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listOrphanMedia(space.vaultId);
      const items = list.orphans;
      setOrphans(items);
      setListSpace(list.vault_id);
      setSelected((previous) => {
        const names = new Set(items.map((item) => item.file_name));
        return new Set([...previous].filter((name) => names.has(name)));
      });
    } catch (e) {
      setError(String(e));
    }
  }, [space.vaultId]);

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
      if (listSpace === null) return;
      const result = await promoteOrphanMedia(listSpace, selectedNames);
      setSummary(`Converted ${result.created.length}, skipped ${result.skipped.length}`);
      await reload();
    } catch (e) {
      setError(String(e));
      await reload();
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
      if (listSpace === null) return;
      const result = await deleteOrphanMedia(listSpace, selectedNames);
      setSummary(`Deleted ${result.deleted.length}, skipped ${result.skipped.length}`);
    } catch (e) {
      setError(String(e));
    } finally {
      // Trash may move some files before reporting an error.
      await reload();
      setWorking(null);
    }
  };

  return (
    <section className="flex flex-col gap-s3">
      <div className="flex items-center justify-between gap-s2">
        <h1 className="text-base font-semibold">
          Orphans{" "}
          <span className="font-normal text-muted-foreground">{orphans.length}</span>
        </h1>
        <Button variant="secondary" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
      <p className="text-base text-muted-foreground">{DESCRIPTION}</p>

      {selector}

      {orphans.length === 0 ? (
        <p className="py-12 text-center text-base text-muted-foreground">No orphan media</p>
      ) : (
        <div className="flex flex-col rounded-1 border border-border">
          <div className="flex h-8 items-center gap-s2 border-b border-border px-3">
            <Checkbox
              aria-label="Select all orphans"
              checked={selectAllState}
              onCheckedChange={toggleAll}
            />
            <span className="text-base text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </div>
          <ul className="flex max-h-[320px] flex-col overflow-y-auto p-1">
            {orphans.map((item) => {
              const isImage = IMAGE_EXTS.has(fileExt(item.file_name));
              return (
                <li key={item.file_name}>
                  <label className="flex h-10 items-center gap-s2 rounded-1 px-2 hover:state-active">
                    <Checkbox
                      aria-label={`Select ${item.file_name}`}
                      checked={selected.has(item.file_name)}
                      onCheckedChange={() => toggleOne(item.file_name)}
                    />
                    {isImage ? (
                      <img
                        src={mediaUrl(space.path, item.file_name)}
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
                    <span className="shrink-0 text-base text-muted-foreground">
                      {formatBytes(item.size_bytes)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {summary && <p className="text-base text-muted-foreground">{summary}</p>}
      {error && <p className="text-base text-destructive">{error}</p>}

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
