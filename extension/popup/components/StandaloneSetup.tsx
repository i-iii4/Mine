// First contact without the app (О1–О3).
//
// The extension is published openly, so for many people this screen is the
// product's front door: no native host answered, and the clipper must offer a
// complete path — choose a folder, save straight into it — rather than an
// error about software they never installed. The app is an upgrade, not a
// prerequisite, and the copy holds that order.

import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { ClipperOverflowMenu } from "./ClipperOverflowMenu";

/** Where "Download app" points until the product has a page of its own. */
export const APP_DOWNLOAD_URL = "https://github.com/i-iii4/Mine/releases";

interface StandaloneSetupProps {
  canPickFolder: boolean;
  /** A folder was chosen before, but the browser dropped write access to it. */
  folderName: string | null;
  onChooseFolder: () => Promise<{ ok: boolean; error?: string | null }>;
  onRegrantAccess: () => Promise<{ ok: boolean; error?: string | null }>;
  onClose?: () => void;
}

export function StandaloneSetup({
  canPickFolder,
  folderName,
  onChooseFolder,
  onRegrantAccess,
  onClose,
}: StandaloneSetupProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<{ ok: boolean; error?: string | null }>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok && result.error) setError(result.error);
  };

  return (
    <div className="flex min-h-0 flex-col" data-clipper-standalone-setup="">
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-accent px-3">
        <span className="text-base font-semibold text-foreground">Mine Clipper</span>
        {onClose && <ChromeCloseButton className="ml-auto" label="Close clipper" onClick={onClose} />}
      </div>

      <div className="flex flex-col items-start gap-3 p-4 text-left">
        <p className="text-sm text-muted-foreground">
          Clips are saved as plain files into a folder you choose — no account,
          no cloud. The Mine app adds previews and a feed on top of the same
          folder whenever you install it.
        </p>

        {folderName && (
          <p className="text-sm text-muted-foreground">
            The browser dropped access to “{folderName}”.
          </p>
        )}
        {!folderName && !canPickFolder && (
          <p className="text-sm text-muted-foreground">
            Open the clipper from the toolbar icon to choose the folder — a page
            overlay cannot ask for folder access.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {folderName ? (
            <Button disabled={busy} onClick={() => void run(onRegrantAccess)}>
              Allow access to {folderName}
            </Button>
          ) : canPickFolder ? (
            <Button disabled={busy} onClick={() => void run(onChooseFolder)}>
              Choose folder…
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => void chrome.tabs?.create({ url: APP_DOWNLOAD_URL })}>
            Download app
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/** The header row while saving straight to disk: the folder is the space. */
export function StandaloneFolderRow({
  folderName,
  onClose,
}: {
  folderName: string | null;
  onClose?: () => void;
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
      <span className="font-mono text-sm text-muted-foreground">no app</span>
      <span className="ml-auto flex items-center gap-1">
        <ClipperOverflowMenu appInstalled={false} />
        {onClose && <ChromeCloseButton label="Close clipper" onClick={onClose} />}
      </span>
    </div>
  );
}
