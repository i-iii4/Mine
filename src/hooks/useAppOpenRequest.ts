import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { selectVault } from "@/lib/commands";

/** Subscribe before consuming retained OS requests, after startup has settled. */
export function useAppOpenRequest(ready: boolean, onSelected: (path: string) => void) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || !isTauri()) return;
    let cancelled = false;
    let running = false;
    let notified = false;
    const drain = async () => {
      notified = true;
      if (running || cancelled) return;
      running = true;
      try {
        while (notified && !cancelled) {
          notified = false;
          const path = await invoke<string | null>("take_open_space_request");
          if (!path || cancelled) continue;
          await selectVault(path);
          if (!cancelled) {
            onSelected(path);
            setError(null);
          }
          notified = true;
        }
      } catch (cause) {
        if (!cancelled) setError(`Could not open space: ${String(cause)}`);
      } finally {
        running = false;
      }
    };
    const subscription = listen("open-space-requested", () => { void drain(); });
    void subscription.then(() => { void drain(); }).catch((cause) => {
      if (!cancelled) setError(String(cause));
    });
    return () => {
      cancelled = true;
      void subscription.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [ready, onSelected]);
  return error;
}
