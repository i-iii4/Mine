import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StandaloneSetup } from "./StandaloneSetup";
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
    setupGeneration.current += 1;
    const next = await action();
    setStatus(next);
    if (!next.configured || next.permission !== "granted") {
      return { ok: false, error: next.error };
    }
    const notified = await notifyStandaloneFolderChanged(bindingId);
    if (!notified.ok) return notified;
    setCompleted(true);
    return { ok: true };
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
    <StandaloneSetup
      canPickFolder={canPickFolderHere()}
      folderName={status.configured ? status.folderName ?? null : null}
      allowFolderChange={!bindingId}
      diagnosis={status.error}
      onChooseFolder={() => configure(chooseStandaloneFolder)}
      onRegrantAccess={() => configure(() => regrantStandaloneAccess(bindingId))}
      onClose={() => window.close()}
    />
  );
}
