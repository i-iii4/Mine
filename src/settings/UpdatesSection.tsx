import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { checkForUpdates, downloadUpdate, getUpdateStatus, installUpdate, restorePreviousUpdate } from "@/lib/commands";
import type { UpdateStatus } from "@/types";
import { SettingRow } from "./SettingRow";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "kind" in error) {
    const value = error as { kind: string; detail?: string };
    if (value.kind === "busy") return "Another operation is still running. Try again when it finishes.";
    if (value.kind === "disabled") return "Updates are not configured for this build.";
    if (value.kind === "activation_unavailable") return "This build cannot safely install updates yet.";
    if (value.kind === "signature" || value.kind === "archive_changed") return "The update could not be verified. Nothing was installed.";
    return value.detail ?? "The update could not be completed. Try again.";
  }
  return typeof error === "string" ? error : "The update could not be completed. Try again.";
}

export function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    let current = true;
    let receivedEvent = false;
    mounted.current = true;
    const unlisten = listen<UpdateStatus>("update-status", (event) => {
      if (current) { receivedEvent = true; setStatus(event.payload); }
    }).catch(() => () => {});
    void getUpdateStatus().then((value) => {
      if (current && !receivedEvent) setStatus(value);
    }).catch((reason: unknown) => {
      if (current) setError(errorMessage(reason));
    });
    return () => {
      current = false;
      mounted.current = false;
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  async function run(label: string, operation: () => Promise<UpdateStatus>, isCheck = false) {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    setError(null);
    try {
      const next = await operation();
      if (mounted.current) {
        setStatus(next);
        if (isCheck) setChecked(true);
      }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const disabled = status?.stage === "disabled";
  const activating = status?.stage === "installing" || status?.stage === "restarting";
  const working = activating || status?.stage === "checking" || status?.stage === "downloading";
  const message = disabled ? "Updates are not configured for this build."
    : status?.stage === "downloading" ? "Downloading the update. You can keep using Mine."
    : status?.stage === "installing" ? "Preparing a safe restart."
    : status?.stage === "restarting" ? "Restarting Mine to finish the update."
    : status?.stage === "activated" ? `Version ${status.version} is installed.`
    : status?.stage === "rolled_back" ? "The previous version was restored."
    : status?.stage === "recovery_required" ? "The update needs recovery. The previous version has been retained."
    : status?.stage === "verified" ? `Version ${status.version} is downloaded and verified.`
    : status?.stage === "available" ? `Version ${status.version} is available.`
    : checked && status?.stage === "idle" ? "You are up to date."
    : status ? "Check for a new version of Mine." : "Reading update status…";
  const failure = error ?? (status?.error ? errorMessage(status.error) : null);

  return (
    <section className="grid gap-s3" data-settings-section="updates">
      <h2 className="text-base font-semibold">Updates</h2>
      <SettingRow label="Mine" caption={message}>
        <div className="flex items-center gap-2">
          {status?.stage === "recovery_required" && (
            <Button disabled={busy !== null} onClick={() => void run("Preparing recovery…", restorePreviousUpdate)}>
              {busy === "Preparing recovery…" ? busy : "Restore previous version"}
            </Button>
          )}
          {status?.stage === "available" && (
            <Button disabled={busy !== null} onClick={() => void run("Downloading…", downloadUpdate)}>
              {busy === "Downloading…" ? busy : "Download update"}
            </Button>
          )}
          {status?.stage === "verified" && status.activation_available && (
            <Button disabled={busy !== null} onClick={() => void run("Preparing restart…", installUpdate)}>
              {busy === "Preparing restart…" ? busy : "Restart and install"}
            </Button>
          )}
          <Button variant="secondary" disabled={busy !== null || !status || disabled || working || status.stage === "recovery_required"}
            onClick={() => void run("Checking…", checkForUpdates, true)}>
            {busy === "Checking…" ? busy : "Check for updates"}
          </Button>
        </div>
      </SettingRow>
      {status?.stage === "downloading" && (
        <progress aria-label="Update download" className="w-full" max={status.total_bytes ?? undefined}
          value={status.total_bytes ? status.downloaded_bytes : undefined} />
      )}
      {status?.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{status.notes}</p>}
      {status?.stage === "verified" && !status.activation_available && (
        <p className="text-sm text-muted-foreground">Installation is unavailable in this build. Your current version has not changed.</p>
      )}
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      {busy && <span role="status" className="sr-only">{busy}</span>}
    </section>
  );
}
