// VaultConflictsNotice: the space's iCloud sync conflicts, told by a notice
// of the lead tab and resolved in their window (SPEC_ICLOUD_CONFLICTS.md, ВК10
// по ВК12).
//
// The notice counts the conflict paths the index keeps, without asking
// iCloud; the window asks iCloud for each note's versions as it opens.
// Closing the notice is remembered by this page only, against the paths it
// saw: a new path brings it back, and so does opening the space again.

import { useCallback, useEffect, useRef, useState } from "react";
import { listenPage } from "@/lib/pageEvents";
import {
  listVaultConflictPaths,
  listVaultConflicts,
  resolveVaultConflict,
} from "@/lib/commands";
import type {
  ConflictChoice,
  ConflictVersion,
  VaultConflict,
  VaultConflictError,
  VaultConflictsChanged,
} from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MODAL_DETAIL_CLASS, MODAL_ERROR_CLASS } from "@/components/ui/modal-window";
import { NotificationCard } from "@/components/NotificationCard";

/** The space's set of conflict paths changed (ВК6). */
export const VAULT_CONFLICTS_CHANGED_EVENT = "vault-conflicts-changed";

export const VAULT_CONFLICTS_TITLE = "Resolve iCloud sync conflicts";

export const VAULT_CONFLICTS_DESCRIPTION =
  "iCloud kept more than one version of these notes. Keep one version of each: the others go to the Trash. Keep all puts the other versions next to the note as separate notes.";

/** The words of a recorded conflict iCloud did not answer about this time:
 *  the notice counts it, so the window shows it, with nothing to keep until
 *  iCloud answers (SPEC_DEEP_AUDIT.md, Е5.12). */
export const CONFLICT_UNANSWERED_TEXT =
  "iCloud did not answer about this note. Mine asks again when you come back to the window.";

/** The note's name from its path: `Cards/Note.md` is `Note`. */
function noteName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.endsWith(".md") ? file.slice(0, -".md".length) : file;
}

/** The notice's title and text for these conflict paths (ВК10). */
export function conflictNoticeText(paths: readonly string[]): { title: string; text: string } {
  const [only] = paths;
  if (paths.length === 1 && only !== undefined) {
    return {
      title: "iCloud sync conflict",
      text: `“${noteName(only)}” has versions from more than one device.`,
    };
  }
  return {
    title: `${paths.length} iCloud sync conflicts`,
    text: `${paths.length} notes have versions from more than one device.`,
  };
}

/** Whether the notice shows: some note is in conflict, and the person did
 *  not close the notice, or a path came that was not there when they did. */
export function noticeVisible(paths: readonly string[], closedWith: ReadonlySet<string> | null): boolean {
  if (paths.length === 0) return false;
  if (closedWith === null) return true;
  return paths.some((path) => !closedWith.has(path));
}

/** `{date}, {HH:MM}` of a version, the date as the open card shows it. */
function versionTime(modified: string | null | undefined): string | null {
  if (!modified) return null;
  const date = new Date(modified);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

/** The label of a version's row (ВК11, user's decision of 11.10.2026): the
 *  version in the folder is `In the folder · {date}`, a hidden one
 *  `Hidden version · {device} · {date}`. */
export function versionLabel(version: ConflictVersion, inFolder: boolean): string {
  const parts = inFolder
    ? ["In the folder"]
    : ["Hidden version", version.device?.trim() || "Unknown device"];
  const time = versionTime(version.modified);
  if (time !== null) parts.push(time);
  return parts.join(" · ");
}

/** What the window says under a conflict's group for a refusal (ВК12);
 *  `null` says nothing. */
export function conflictErrorText(error: VaultConflictError, name: string): string | null {
  switch (error.kind) {
    case "no_vault":
      return "No space is open.";
    case "invalid_path":
      return `Mine cannot use the path “${error.path}”.`;
    case "not_pending":
      return null;
    case "versions_changed":
      return `The versions of “${name}” changed. The list shows them again.`;
    case "source_changed":
      return `“${name}” changed outside Mine; nothing was changed. Try again.`;
    case "helper_failed":
      return `iCloud did not answer: ${error.message}`;
    case "trash_failed":
      return "The other versions stayed next to the note as separate notes: the Trash refused them.";
    case "internal":
      return error.message;
  }
}

/** The key of a button in a group: a version's token, the version in the
 *  folder, or Keep all. */
export type ConflictActionKey = string;
export const KEEP_IN_FOLDER: ConflictActionKey = "in-folder";
export const KEEP_ALL: ConflictActionKey = "keep-all";

/** The notice in the lead tab and the window behind its `Review` (ВК10). */
export function VaultConflictsNotice({ vaultReady }: { vaultReady: boolean }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [closedWith, setClosedWith] = useState<ReadonlySet<string> | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPaths(await listVaultConflictPaths());
    } catch (error) {
      // Without the count the notice stays as it was; it is a hint, not the
      // only way to learn of a conflict.
      console.warn("iCloud conflicts could not be counted:", error);
    }
  }, []);

  useEffect(() => {
    if (!vaultReady) return;
    void refresh();
    // A check that failed is in the log only (decision of 14.10.2026).
    const subscription = listenPage<VaultConflictsChanged>(VAULT_CONFLICTS_CHANGED_EVENT, () => {
      void refresh();
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, [vaultReady, refresh]);

  const { title, text } = conflictNoticeText(paths);
  return (
    <>
      {noticeVisible(paths, closedWith) && (
        <div data-vault-conflicts-notice="">
          <NotificationCard title={title} onClose={() => setClosedWith(new Set(paths))}>
            <p className="text-sm text-muted-foreground">{text}</p>
            <div>
              <Button size="sm" onClick={() => setOpen(true)}>
                Review
              </Button>
            </div>
          </NotificationCard>
        </div>
      )}
      {open && <VaultConflictsWindow onClose={() => setOpen(false)} />}
    </>
  );
}

/** A conflict the window still shows after it was resolved, for the words
 *  under it. */
export interface SettledConflict {
  conflict: VaultConflict;
  message: string;
}

/** The window with its data: the versions read from iCloud as it opens, and
 *  each resolution sent and read back. */
function VaultConflictsWindow({ onClose }: { onClose: () => void }) {
  const [conflicts, setConflicts] = useState<VaultConflict[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, ConflictActionKey>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settled, setSettled] = useState<SettledConflict[]>([]);
  const settledRef = useRef(settled);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The list is read when the window opens and after each resolution, never
  // because the page above drew again: each read runs the iCloud helper.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /** Read the list again; the window closes when nothing is left. */
  const reload = useCallback(async () => {
    try {
      const list = await listVaultConflicts();
      if (!mounted.current) return;
      setListError(null);
      setConflicts(list);
      if (list.length === 0 && settledRef.current.length === 0) onCloseRef.current();
    } catch (error) {
      if (!mounted.current) return;
      // `listVaultConflicts` throws only `VaultConflictError`: its wrapper
      // turns any other failure into the `internal` kind.
      const refusal = error as VaultConflictError;
      setListError(conflictErrorText(refusal, ""));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const resolve = useCallback(async (conflict: VaultConflict, key: ConflictActionKey, choice: ConflictChoice) => {
    const tokens = conflict.versions.flatMap((version) => (version.token ? [version.token] : []));
    setBusy((current) => ({ ...current, [conflict.path]: key }));
    setErrors(({ [conflict.path]: _cleared, ...rest }) => rest);
    let message: string | null = null;
    let resolved = false;
    try {
      await resolveVaultConflict(conflict.path, choice, tokens);
      resolved = true;
    } catch (error) {
      // `resolveVaultConflict` throws only `VaultConflictError`.
      const refusal = error as VaultConflictError;
      message = conflictErrorText(refusal, conflict.name);
      // Resolved, but the other versions stayed in the space: the group
      // stays with the words, without its buttons.
      if (refusal.kind === "trash_failed" && message !== null) {
        // The ref first: the list read below decides on it whether the
        // window may close, before the next render.
        const next = [...settledRef.current, { conflict, message }];
        settledRef.current = next;
        setSettled(next);
        resolved = true;
        message = null;
      }
      if (refusal.kind === "not_pending") resolved = true;
    }
    if (!mounted.current) return;
    setBusy(({ [conflict.path]: _done, ...rest }) => rest);
    if (message !== null) {
      const words = message;
      setErrors((current) => ({ ...current, [conflict.path]: words }));
    }
    if (resolved) {
      setConflicts((current) => current?.filter((item) => item.path !== conflict.path) ?? current);
    }
    await reload();
  }, [reload]);

  const shown = conflicts ?? [];
  const settledShown = settled.filter(
    ({ conflict }) => !shown.some((item) => item.path === conflict.path),
  );
  return (
    <VaultConflictsDialog
      open
      conflicts={shown}
      settled={settledShown}
      busy={busy}
      errors={errors}
      listError={listError}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onKeep={(conflict, token) => void resolve(
        conflict,
        token ?? KEEP_IN_FOLDER,
        { kind: "keep_version", token },
      )}
      onKeepAll={(conflict) => void resolve(conflict, KEEP_ALL, { kind: "keep_all" })}
    />
  );
}

/** The window itself, free of IPC, so `/__popups` can draw it with fixed
 *  inputs (ВК11): a framed group per conflict, a row and a `Keep` per
 *  version, `Keep all` under them, the error under its own group, and no
 *  buttons at the bottom: the cross and Escape close it. */
export function VaultConflictsDialog({
  open,
  conflicts,
  settled = [],
  busy,
  errors,
  listError = null,
  onOpenChange,
  onKeep,
  onKeepAll,
}: {
  open: boolean;
  conflicts: readonly VaultConflict[];
  settled?: readonly SettledConflict[];
  /** The pressed button of each group being resolved, by path. */
  busy: Readonly<Record<string, ConflictActionKey>>;
  /** The words under each group, by path. */
  errors: Readonly<Record<string, string>>;
  listError?: string | null;
  onOpenChange: (open: boolean) => void;
  onKeep: (conflict: VaultConflict, token: string | null) => void;
  onKeepAll: (conflict: VaultConflict) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{VAULT_CONFLICTS_TITLE}</DialogTitle>
          <DialogDescription>{VAULT_CONFLICTS_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        {listError !== null && <p className={MODAL_ERROR_CLASS}>{listError}</p>}

        {/* A framed group per conflict: its text 12px inside the frame, the
            name and path 4px apart, the rows and buttons 8px apart. */}
        <div className="flex max-h-[60vh] min-w-0 flex-col gap-2 overflow-y-auto">
          {conflicts.map((conflict) => {
            if (conflict.unanswered) {
              return (
                <div
                  key={conflict.path}
                  className="grid min-w-0 gap-2 rounded-1 border border-border p-3"
                  data-conflict-group={conflict.path}
                >
                  <div className="grid min-w-0 gap-1">
                    <div className="min-w-0 truncate text-base text-foreground">{conflict.name}</div>
                    <div className={MODAL_DETAIL_CLASS}>{conflict.path}</div>
                  </div>
                  <p className="text-sm text-muted-foreground" data-conflict-unanswered="">
                    {CONFLICT_UNANSWERED_TEXT}
                  </p>
                </div>
              );
            }
            const pressed = busy[conflict.path];
            const resolving = pressed !== undefined;
            const label = (key: ConflictActionKey, idle: string) => (pressed === key ? "Keeping…" : idle);
            return (
              <div
                key={conflict.path}
                className="grid min-w-0 gap-2 rounded-1 border border-border p-3"
                data-conflict-group={conflict.path}
              >
                <div className="grid min-w-0 gap-1">
                  <div className="min-w-0 truncate text-base text-foreground">{conflict.name}</div>
                  <div className={MODAL_DETAIL_CLASS}>{conflict.path}</div>
                </div>
                <div className="grid min-w-0 gap-2">
                  <div className="flex min-w-0 items-center gap-2" data-conflict-version="in-folder">
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {versionLabel(conflict.current, true)}
                    </span>
                    {/* The main button keeps what is on disk (user's decision
                        of 11.10.2026). */}
                    <Button
                      size="xs"
                      variant="default"
                      disabled={resolving}
                      onClick={() => onKeep(conflict, null)}
                    >
                      {label(KEEP_IN_FOLDER, "Keep")}
                    </Button>
                  </div>
                  {conflict.versions.map((version, index) => (
                    <div
                      key={version.token ?? index}
                      className="flex min-w-0 items-center gap-2"
                      data-conflict-version="hidden"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {versionLabel(version, false)}
                      </span>
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={resolving || !version.token}
                        onClick={() => onKeep(conflict, version.token ?? null)}
                      >
                        {label(version.token ?? "", "Keep")}
                      </Button>
                    </div>
                  ))}
                </div>
                <div>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={resolving}
                    onClick={() => onKeepAll(conflict)}
                  >
                    {label(KEEP_ALL, "Keep all")}
                  </Button>
                </div>
                {errors[conflict.path] && (
                  <p className={MODAL_ERROR_CLASS} data-conflict-error="">
                    {errors[conflict.path]}
                  </p>
                )}
              </div>
            );
          })}
          {settled.map(({ conflict, message }) => (
            <div
              key={conflict.path}
              className="grid min-w-0 gap-2 rounded-1 border border-border p-3"
              data-conflict-group={conflict.path}
            >
              <div className="grid min-w-0 gap-1">
                <div className="min-w-0 truncate text-base text-foreground">{conflict.name}</div>
                <div className={MODAL_DETAIL_CLASS}>{conflict.path}</div>
              </div>
              <p className={MODAL_ERROR_CLASS} data-conflict-error="">{message}</p>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
