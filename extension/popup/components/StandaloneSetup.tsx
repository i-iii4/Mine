// Connection recovery and folder permission are separate from app installation.

import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { ClipperOverflowMenu } from "./ClipperOverflowMenu";
import { openDownloadPage } from "../lib/standalone";

/** Where "Download app" points until the product has a page of its own. */
export const APP_DOWNLOAD_URL = "https://github.com/i-iii4/Mine/releases";

interface StandaloneSetupProps {
  canPickFolder: boolean;
  /** A folder was chosen before, but the browser dropped write access to it. */
  folderName: string | null;
  allowFolderChange?: boolean;
  diagnosis?: string | null;
  nativeConnected?: boolean;
  onRetryConnection?: () => Promise<unknown>;
  onChooseNativeFolder?: () => Promise<unknown>;
  onChooseFolder: () => Promise<{ ok: boolean; error?: string | null }>;
  onRegrantAccess: () => Promise<{ ok: boolean; error?: string | null }>;
  onClose?: () => void;
}

export function StandaloneSetup({
  canPickFolder,
  folderName,
  allowFolderChange = true,
  diagnosis,
  nativeConnected = false,
  onRetryConnection,
  onChooseNativeFolder,
  onChooseFolder,
  onRegrantAccess,
  onClose,
}: StandaloneSetupProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<{ ok: boolean; error?: string | null }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok && result.error) setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col" data-clipper-standalone-setup="">
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-accent px-3">
        <span className="text-base font-semibold text-foreground">Mine</span>
        {onClose && <ChromeCloseButton className="ml-auto" label="Close" onClick={onClose} />}
      </div>

      <div className="flex flex-col items-start gap-3 p-4 text-left">
        <p className="text-sm text-muted-foreground">
          Choose where to save your clips. The browser can save plain files
          in a folder without the Mine app. Your draft stays here while you set it up.
        </p>

        {folderName && (
          <p className="text-sm text-muted-foreground">
            Check write access to “{folderName}” to keep saving in the same folder.
          </p>
        )}
        {!canPickFolder && (
          <p className="text-sm text-muted-foreground">
            Folder setup opens in a separate Mine window so access belongs to
            the extension, not this website.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {folderName && <Button disabled={busy} onClick={() => void run(onRegrantAccess)}>Allow access</Button>}
          {allowFolderChange && <Button variant={folderName ? "secondary" : "default"} disabled={busy} onClick={() => void run(onChooseFolder)}>
            Choose folder…
          </Button>}
          {nativeConnected && onChooseNativeFolder && (
            <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await onChooseNativeFolder(); return { ok: true }; })}>Choose with Mine…</Button>
          )}
        </div>
        {diagnosis && <p className="text-sm text-muted-foreground" role="status">{diagnosis}</p>}
        {onRetryConnection && <>
          <p className="text-sm text-muted-foreground">If Mine is already installed, open it once to register its helper, then retry.</p>
          <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await onRetryConnection(); return { ok: true }; })}>Retry connection</Button>
        </>}
        <Button variant="ghost" disabled={busy} onClick={() => void run(openDownloadPage)}>Get the Mine app (optional)</Button>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** The header row while saving straight to disk: the folder is the space. */
export function StandaloneFolderRow({
  folderName,
  onClose,
  canOpenApp = false,
  onRetryConnection,
  onChooseNativeFolder,
}: {
  folderName: string | null;
  onClose?: () => void;
  canOpenApp?: boolean;
  onRetryConnection?: () => Promise<unknown>;
  onChooseNativeFolder?: () => Promise<unknown>;
}) {
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-accent px-3"
      data-clipper-standalone-row=""
    >
      <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate text-base text-foreground">
        {folderName ?? "Folder"}
      </span>
      <span className="font-mono text-sm text-muted-foreground">browser</span>
      <span className="ml-auto flex items-center gap-1">
        <ClipperOverflowMenu canOpenApp={canOpenApp} onRetryConnection={onRetryConnection} onChooseNativeFolder={onChooseNativeFolder} />
        {onClose && <ChromeCloseButton label="Close" onClick={onClose} />}
      </span>
    </div>
  );
}
