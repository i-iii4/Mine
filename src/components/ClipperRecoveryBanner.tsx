// ClipperRecoveryBanner — manual recovery for browser clipper saves that
// uploaded media but did not create the matching markdown block.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Image, RotateCcw, Trash2, X } from "lucide-react";
import {
  discardClipperPendingUpload,
  listClipperRecoveryItems,
  recoverClipperPendingUpload,
} from "@/lib/commands";
import type { ClipperRecoveryItem } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ClipperRecoveryBannerProps {
  vaultReady: boolean;
  onRecovered?: (slug: string) => void;
}

export function ClipperRecoveryBanner({
  vaultReady,
  onRecovered,
}: ClipperRecoveryBannerProps) {
  const [items, setItems] = useState<ClipperRecoveryItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listClipperRecoveryItems();
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    void refresh();
    const handles = [
      listen("clipper-recovery-changed", () => void refresh()),
      listen("block:added", () => void refresh()),
      listen("vault-changed", () => void refresh()),
    ];
    return () => {
      handles.forEach((p) => p.then((fn) => fn()));
    };
  }, [vaultReady, refresh]);

  const recover = useCallback(
    async (item: ClipperRecoveryItem) => {
      setBusyId(item.id);
      setError(null);
      try {
        const result = await recoverClipperPendingUpload(item.id);
        onRecovered?.(result.slug);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [onRecovered, refresh],
  );

  const discardPending = useCallback(
    async (item: ClipperRecoveryItem) => {
      if (item.kind !== "pending_upload") {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        await discardClipperPendingUpload(item.id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 flex w-full items-center gap-2 rounded-1 border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-left text-sm text-yellow-100 hover:bg-yellow-500/15"
      >
        <AlertTriangle className="size-4 shrink-0" />
        <span className="flex-1 truncate">
          {items.length === 1
            ? "1 clipper item can be recovered"
            : `${items.length} clipper items can be recovered`}
        </span>
        <span className="text-xs opacity-60">Review</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Recover clipper saves</DialogTitle>
          </DialogHeader>
          <div className="mt-2 text-sm text-muted-foreground">
            These files were uploaded by the browser clipper but are not
            connected to a markdown card yet.
          </div>

          {error && (
            <div className="mt-3 rounded-1 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              {error}
            </div>
          )}

          <div className="mt-4 flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {sortedItems.map((item) => {
              const busy = busyId === item.id;
              return (
                <div
                  key={`${item.kind}:${item.id}`}
                  className="rounded-1 border border-border bg-card p-3"
                >
                  <div className="flex items-start gap-2">
                    <Image className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {item.fileName}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        pending upload
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={busy}
                      onClick={() => recover(item)}
                    >
                      <RotateCcw className="mr-1 size-3.5" />
                      Recover
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => discardPending(item)}
                    >
                      <Trash2 className="mr-1 size-3.5" />
                      Discard upload
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <X className="mr-1 size-3.5" />
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
