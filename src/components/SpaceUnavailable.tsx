// The space is bound but not reachable right now.
//
// Renamed, moved, on an unplugged drive, not yet synced from iCloud — from the
// app's side these are the same situation, and none of them mean the data is
// gone. Before this screen the binding was silently dropped and the app came up
// as if it had never been opened, which is indistinguishable from losing
// everything. The path stays bound until the user says otherwise.
// See SPEC_VAULT_LIFECYCLE.md П12–П16.
//
// One space being gone never locks the others away (П25): every other known
// space is listed here, and an available one opens with one click.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";
import { forgetUnavailableVault, listSpaces, selectVault } from "@/lib/commands";
import type { SpaceEntry, UnavailableVaultReason } from "@/types";

interface SpaceUnavailableProps {
  path: string;
  /// Missing and locked need different words and different actions: "locate
  /// the folder" is useless advice when the folder is visible and macOS is
  /// refusing to open it. See SPEC_ONBOARDING.md О11.
  reason?: UnavailableVaultReason;
  onReopened: (path: string) => void;
  onForgotten: () => void;
  /// Start a new space in another folder, the way the first screen does.
  onCreateNew?: () => void;
}

/// Where macOS keeps the files-and-folders permission this app was denied.
const PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function SpaceUnavailable({
  path,
  reason = "missing",
  onReopened,
  onForgotten,
  onCreateNew,
}: SpaceUnavailableProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherSpaces, setOtherSpaces] = useState<SpaceEntry[]>([]);
  const accessDenied = reason === "access_denied";

  useEffect(() => {
    let cancelled = false;
    listSpaces()
      .then((spaces) => {
        if (!cancelled) setOtherSpaces(spaces.filter((space) => space.path !== path));
      })
      .catch(() => {
        if (!cancelled) setOtherSpaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const openOther = async (other: string) => {
    setError(null);
    setBusy(true);
    try {
      await selectVault(other);
      onReopened(other);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setError(null);
    setBusy(true);
    try {
      await selectVault(path);
      onReopened(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const locate = async () => {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setBusy(true);
    try {
      await selectVault(selected);
      onReopened(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    try {
      await forgetUnavailableVault();
      onForgotten();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      // Fills its container rather than the viewport: the app gives it the
      // whole window, the design-system showcase gives it a box.
      className="flex size-full min-h-80 items-center justify-center bg-background"
      data-space-unavailable=""
    >
      {/* max-w-lg so each variant's action row fits on one line — a wrapped
          row of buttons reads as two rows of controls, which is not a row. */}
      <div className="flex max-w-lg flex-col items-start gap-6 text-left">
        <div className="grid gap-2">
          <h1 className="text-lg font-semibold text-foreground">
            {accessDenied ? "No access to the folder" : "Folder unavailable"}
          </h1>
          <p className="text-base text-muted-foreground">
            {/* Only provable claims: "no folder at the path" is the read result,
                "Mine did not move or delete anything" is a property of the code,
                and the denial is quoted as the system's, not asserted as state —
                a PermissionDenied can come from a parent while the folder itself
                is gone, so "the folder is right here" was never knowledge. */}
            {accessDenied
              ? `macOS is not letting Mine read the “${folderName(path)}” folder. Open System Settings, go to Privacy & Security, Files and Folders, and allow access for Mine.`
              : `There is no “${folderName(path)}” folder at the saved path. This happens when it is renamed, moved or its drive is disconnected. Mine did not move or delete anything.`}
          </p>
          <p className="font-mono text-sm text-muted-foreground" data-space-unavailable-path>
            {path}
          </p>
        </div>

        {/* One primary, the rest secondary, one row per variant. Access denied
            has one real answer — grant access — so "create new space" is not
            offered there; forgetting stays as the only way out of the screen. */}
        <div className="flex items-center gap-2">
          {accessDenied ? (
            <>
              <Button
                onClick={() => void openUrl(PRIVACY_SETTINGS_URL)}
                disabled={busy}
                data-space-unavailable-open-settings=""
              >
                Open System Settings
              </Button>
              <Button variant="secondary" onClick={() => void retry()} disabled={busy}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => void locate()} disabled={busy}>
                Locate folder…
              </Button>
              <Button
                variant="secondary"
                onClick={() => (onCreateNew ? onCreateNew() : void locate())}
                disabled={busy}
                data-space-unavailable-create=""
              >
                Create new space
              </Button>
            </>
          )}
          <Button variant="secondary" onClick={() => void forget()} disabled={busy}>
            Forget this space
          </Button>
        </div>

        {/* Missing only: telling someone whose folder is visible but locked to
            "find it" would be noise. "Reading positions" used to be promised
            here — no such feature exists, the line now claims only what the
            storage model guarantees. */}
        {!accessDenied && (
          <p className="text-sm text-muted-foreground">
            Everything in this space lives in the folder itself. Find it, and
            Mine picks up where it left off.
          </p>
        )}

        {otherSpaces.length > 0 && (
          <div className="grid w-full gap-2" data-space-unavailable-others="">
            <p className="text-sm text-muted-foreground">Other spaces</p>
            <ul className="grid gap-1">
              {otherSpaces.map((space) => (
                <li
                  key={space.path}
                  className="flex items-center justify-between gap-4"
                  data-space-unavailable-other={space.available ? "available" : "unavailable"}
                >
                  <div className="grid min-w-0">
                    <span className={space.available ? "truncate text-base text-foreground" : "truncate text-base text-muted-foreground"}>
                      {space.name}
                    </span>
                    <span className="truncate font-mono text-sm text-muted-foreground">{space.path}</span>
                  </div>
                  {space.available ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void openOther(space.path)}
                      disabled={busy}
                      aria-label={`Open ${space.name}`}
                    >
                      Open
                    </Button>
                  ) : (
                    <span className="shrink-0 text-sm text-muted-foreground">Unavailable</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
