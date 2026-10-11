// VaultConflictsBanner — surfaces unresolved iCloud sync conflicts
// recorded by the watcher (Phase 18.G.3) and lets the user choose a
// resolution per conflict (Phase 18.G.4).

import { useCallback, useEffect, useMemo, useState } from "react";
import { listenPage } from "@/lib/pageEvents";
import { AlertTriangle } from "lucide-react";
import {
  listVaultConflicts,
  resolveVaultConflict,
  type VaultConflictItem,
  type VaultConflictResolveAction,
} from "@/lib/commands";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MODAL_DETAIL_CLASS, MODAL_ERROR_CLASS } from "@/components/ui/modal-window";

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
      listenPage("vault-conflict-detected", () => void refresh()),
      listenPage("vault-conflict-resolved", () => void refresh()),
      listenPage("vault-changed", () => void refresh()),
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
      {/* The destructive button's flat fill and text (SPEC_COLOR_RULES.md,
          3.8): the banner is pressed like it and says the same alarm. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 flex w-full items-center gap-2 rounded-1 bg-destructive-fill px-3 py-2 text-left text-sm text-destructive-foreground hover:bg-destructive-fill-hover"
      >
        <AlertTriangle className="size-[13px] shrink-0" />
        <span className="flex-1 truncate">
          {count === 1
            ? "1 iCloud sync conflict"
            : `${count} iCloud sync conflicts`}
        </span>
        <span>Review</span>
      </button>

      <VaultConflictsDialog
        open={open}
        conflicts={sortedConflicts}
        resolvingKey={resolvingKey}
        error={error}
        keyFor={keyFor}
        onOpenChange={setOpen}
        onResolve={(item, action) => void handleResolve(item, action)}
      />
    </>
  );
}

/** One window per conflicting file pair: its two names and the three ways
 *  out, newest first. */
export function VaultConflictsDialog({
  open,
  conflicts,
  resolvingKey,
  error,
  keyFor,
  onOpenChange,
  onResolve,
}: {
  open: boolean;
  conflicts: readonly VaultConflictItem[];
  resolvingKey: string | null;
  error: string | null;
  keyFor: (item: VaultConflictItem) => string;
  onOpenChange: (open: boolean) => void;
  onResolve: (item: VaultConflictItem, action: VaultConflictResolveAction) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve iCloud sync conflicts</DialogTitle>
          <DialogDescription>
            iCloud detected parallel edits to these elements on different
            devices. Choose how to resolve each one. Files on disk are moved or
            archived according to your choice; the index updates accordingly.
          </DialogDescription>
        </DialogHeader>

        {error && <p className={MODAL_ERROR_CLASS}>{error}</p>}

        {/* A framed group per conflict: its text 12px inside the frame (4
            and 8, as text without a plate), the names 4px apart, the
            buttons 8px under them. */}
        <div className="flex max-h-[60vh] min-w-0 flex-col gap-2 overflow-y-auto">
          {conflicts.map((item) => {
            const key = keyFor(item);
            const busy = resolvingKey === key;
            return (
              <div key={key} className="grid min-w-0 gap-2 rounded-1 border border-border p-3">
                <div className="grid min-w-0 gap-1">
                  <div className="min-w-0 truncate text-base text-foreground">{item.baseSlug}</div>
                  <div className={MODAL_DETAIL_CLASS}>Conflict copy: {item.conflictSlug}.md</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="default"
                    disabled={busy}
                    onClick={() => onResolve(item, "keep_original")}
                  >
                    Keep original
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onResolve(item, "keep_conflict")}
                  >
                    Keep conflict version
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onResolve(item, "dismiss_for_manual_merge")}
                  >
                    I'll merge manually
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
