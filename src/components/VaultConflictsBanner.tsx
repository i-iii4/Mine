// VaultConflictsBanner — surfaces unresolved iCloud sync conflicts
// recorded by the watcher (Phase 18.G.3) and lets the user choose a
// resolution per conflict (Phase 18.G.4).

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Check, Edit3, Trash2, X } from "lucide-react";
import {
  listVaultConflicts,
  resolveVaultConflict,
  type VaultConflictItem,
  type VaultConflictResolveAction,
} from "@/lib/commands";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface VaultConflictsBannerProps {
  vaultReady: boolean;
}

export function VaultConflictsBanner({ vaultReady }: VaultConflictsBannerProps) {
  const [conflicts, setConflicts] = useState<VaultConflictItem[]>([]);
  const [open, setOpen] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listVaultConflicts();
      setConflicts(list);
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
      listen("vault-conflict-detected", () => void refresh()),
      listen("vault-conflict-resolved", () => void refresh()),
      listen("vault-changed", () => void refresh()),
    ];
    return () => {
      handles.forEach((p) => p.then((fn) => fn()));
    };
  }, [vaultReady, refresh]);

  const handleResolve = useCallback(
    async (
      item: VaultConflictItem,
      action: VaultConflictResolveAction,
    ) => {
      const key = `${item.baseSlug}::${item.conflictSlug}`;
      setResolvingKey(key);
      setError(null);
      try {
        await resolveVaultConflict(item.baseSlug, item.conflictSlug, action);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setResolvingKey(null);
      }
    },
    [refresh],
  );

  const count = conflicts.length;

  const keyFor = useCallback(
    (item: VaultConflictItem) => `${item.baseSlug}::${item.conflictSlug}`,
    [],
  );

  const sortedConflicts = useMemo(
    () =>
      [...conflicts].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
    [conflicts],
  );

  if (count === 0) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-1 border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-sm text-destructive-foreground hover:bg-destructive/15"
      >
        <AlertTriangle className="size-4 shrink-0" />
        <span className="flex-1 truncate">
          {count === 1
            ? "1 iCloud sync conflict"
            : `${count} iCloud sync conflicts`}
        </span>
        <span className="text-xs opacity-60">Review</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Resolve iCloud sync conflicts</DialogTitle>
          </DialogHeader>
          <div className="mt-2 text-sm text-muted-foreground">
            iCloud detected parallel edits to these blocks on different devices.
            Choose how to resolve each one. Files on disk are moved or archived
            according to your choice; the index updates accordingly.
          </div>

          {error && (
            <div className="mt-3 rounded-1 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              {error}
            </div>
          )}

          <div className="mt-4 flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {sortedConflicts.map((item) => {
              const key = keyFor(item);
              const busy = resolvingKey === key;
              return (
                <div
                  key={key}
                  className="rounded-1 border border-border bg-card p-3"
                >
                  <div className="text-sm font-medium">{item.baseSlug}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    conflict file: {item.conflictSlug}.md
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={busy}
                      onClick={() => handleResolve(item, "keep_original")}
                    >
                      <Trash2 className="mr-1 size-3.5" />
                      Keep original
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      disabled={busy}
                      onClick={() => handleResolve(item, "keep_conflict")}
                    >
                      <Check className="mr-1 size-3.5" />
                      Keep conflict version
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        handleResolve(item, "dismiss_for_manual_merge")
                      }
                    >
                      <Edit3 className="mr-1 size-3.5" />
                      I'll merge manually
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
