import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  canPickFolderHere, chooseStandaloneFolder, getStandaloneStatus, getBoundFolderStatus,
  notifyStandaloneFolderChanged, regrantStandaloneAccess,
  type StandaloneStatus,
} from "../lib/standalone";

/** This component never extracts the setup page as a clip or replaces a draft. */
export function FolderSetupPage() {
  const bindingId = new URLSearchParams(window.location.search).get("binding_id") ?? undefined;
  const [status, setStatus] = useState<StandaloneStatus>({ configured: false });
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setupGeneration = useRef(0);

  useEffect(() => {
    let current = true;
    const generation = setupGeneration.current;
    void (bindingId ? getBoundFolderStatus(bindingId) : getStandaloneStatus()).then((next) => {
      if (current && generation === setupGeneration.current) setStatus(next);
    }).catch((cause) => {
      if (current) setStatus({ configured: false, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { current = false; };
  }, [bindingId]);

  async function configure(action: () => Promise<StandaloneStatus>) {
    if (busy) return;
    setupGeneration.current += 1;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (!next.configured || next.permission !== "granted") {
        setError(next.error ?? null);
        return;
      }
      setStatus(next);
      const notified = await notifyStandaloneFolderChanged(bindingId);
      if (!notified.ok) {
        setError(notified.error ?? "Could not return the selected folder to your clip. Try again.");
        return;
      }
      setCompleted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (completed) {
    return (
      <div className="grid gap-3 p-4">
        <p className="text-base">“{status.folderName}” is ready.</p>
        <p className="text-sm text-muted-foreground">Return to your clip. Its title, content and collections have been kept.</p>
        <Button onClick={() => window.close()}>Return to clip</Button>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 p-4" aria-labelledby="folder-access-title">
      <h1 id="folder-access-title" className="text-base font-semibold">{bindingId ? "Restore folder access" : "Choose a folder for your clips"}</h1>
      <p className="text-sm text-muted-foreground">
        {bindingId ? `Allow Mine to write to ${status.folderName ?? "the original folder"}.`
          : "Select a folder in the system dialog. Your clip stays in the original window."}
      </p>
      {(error ?? status.error) && <p role="alert" className="text-sm text-destructive">{error ?? status.error}</p>}
      <div className="flex items-center gap-2">
        <Button disabled={busy || !canPickFolderHere()} onClick={() => void configure(
          bindingId ? () => regrantStandaloneAccess(bindingId) : chooseStandaloneFolder,
        )}>{busy ? "Waiting for folder access…" : bindingId ? "Allow access" : "Choose folder…"}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => window.close()}>Cancel</Button>
      </div>
    </section>
  );
}
