// The space is bound but not reachable right now.
//
// Renamed, moved, on an unplugged drive, not yet synced from iCloud — from the
// app's side these are the same situation, and none of them mean the data is
// gone. Before this screen the binding was silently dropped and the app came up
// as if it had never been opened, which is indistinguishable from losing
// everything. The path stays bound until the user says otherwise.
// See SPEC_VAULT_LIFECYCLE.md П12–П16.

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";
import { forgetUnavailableVault, selectVault } from "@/lib/commands";
import type { UnavailableVaultReason } from "@/types";

interface SpaceUnavailableProps {
  path: string;
  /// Missing and locked need different words and different actions: "locate
  /// the folder" is useless advice when the folder is visible and macOS is
  /// refusing to open it. See SPEC_ONBOARDING.md О11.
  reason?: UnavailableVaultReason;
  onReopened: (path: string) => void;
  onForgotten: () => void;
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
}: SpaceUnavailableProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessDenied = reason === "access_denied";

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
      <div className="flex max-w-md flex-col items-start gap-6 text-left">
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

        <div className="flex flex-wrap items-center gap-2">
          {accessDenied ? (
            <>
              <Button
                onClick={() => void openUrl(PRIVACY_SETTINGS_URL)}
                disabled={busy}
                data-space-unavailable-open-settings=""
              >
                Open System Settings
              </Button>
              <Button variant="ghost" onClick={() => void retry()} disabled={busy}>
                Try again
              </Button>
            </>
          ) : (
            <Button onClick={() => void locate()} disabled={busy}>
              Locate folder…
            </Button>
          )}
          <Button variant="ghost" onClick={() => void locate()} disabled={busy}>
            Create new space
          </Button>
          <Button variant="ghost" onClick={() => void forget()} disabled={busy}>
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

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
