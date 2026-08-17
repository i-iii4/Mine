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
import { FolderSearch } from "lucide-react";
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
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <FolderSearch className="size-8 text-muted-foreground" aria-hidden="true" />

        <div className="grid gap-2">
          <h1 className="text-lg font-semibold text-foreground">
            {accessDenied ? "No access to the folder" : "Space unavailable"}
          </h1>
          <p className="text-base text-muted-foreground">
            {accessDenied
              ? `“${folderName(path)}” is right here, but macOS is not letting Mine read it. Allow access in System Settings under Privacy & Security, Files and Folders. Your files are untouched.`
              : `Mine cannot reach “${folderName(path)}” right now. It may have been moved or renamed, or its drive may be disconnected. Your files are untouched.`}
          </p>
          <p className="font-mono text-sm text-muted-foreground" data-space-unavailable-path>
            {path}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
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

        <p className="text-sm text-muted-foreground">
          Finding the folder again keeps everything — collections, previews and
          reading positions all survive the move.
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
