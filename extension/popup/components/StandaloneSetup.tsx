// First contact without the app (О1–О3).
//
// The extension is published openly, so for many people this screen is the
// product's front door: no native host answered, and the screen must offer a
// complete path — choose a folder, save straight into it — rather than an
// error about software they never installed. The primary road is still the
// app: the first value of the product (the feed with previews) lives there,
// so Download app leads and the standalone path stands beside it as a full,
// never-required alternative. Decided 17.08.2026.

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
        <span className="text-base font-semibold text-foreground">Mine</span>
        {onClose && <ChromeCloseButton className="ml-auto" label="Close" onClick={onClose} />}
      </div>

      <div className="flex flex-col items-start gap-3 p-4 text-left">
        <p className="text-sm text-muted-foreground">
          Get the Mine app to see what you save as a feed with previews. Or
          save without it: plain files in a folder you choose — no account,
          nothing goes to the cloud. The app opens this same folder whenever
          you install it.
        </p>

        {folderName && (
          <p className="text-sm text-muted-foreground">
            The browser revoked access to “{folderName}”. Allow it again to
            keep saving.
          </p>
        )}
        {!folderName && !canPickFolder && (
          <p className="text-sm text-muted-foreground">
            To choose a folder, click the Mine icon in the browser toolbar.
          </p>
        )}

        {/* The app is the primary road everywhere except when a chosen folder
            lost access — there the person is already saving standalone, and
            restoring their flow outranks the upsell. */}
        <div className="flex items-center gap-2">
          {folderName ? (
            <>
              <Button disabled={busy} onClick={() => void run(onRegrantAccess)}>
                Allow access
              </Button>
              <Button
                variant="secondary"
                onClick={() => void chrome.tabs?.create({ url: APP_DOWNLOAD_URL })}
              >
                Download app
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => void chrome.tabs?.create({ url: APP_DOWNLOAD_URL })}>
                Download app
              </Button>
              {canPickFolder && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run(onChooseFolder)}
                >
                  Choose folder…
                </Button>
              )}
            </>
          )}
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
        {onClose && <ChromeCloseButton label="Close" onClick={onClose} />}
      </span>
    </div>
  );
}
