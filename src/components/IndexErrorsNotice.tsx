// The notes a pass of the space could not read (SPEC_DEEP_AUDIT.md, Н6,
// Е6.17): the index is ready without them, and the lead tab of the space
// names them in a notice. Before 13.10.2026 they were in the journal only,
// and a note the index silently left out just did not show.
//
// The list comes with each pass (`vault-freshness-changed`, `error_files`):
// a pass without errors takes the notice away, and the cross hides it until
// the set of notes changes, as the conflicts notice does.

import { useEffect, useState } from "react";
import { listenPage } from "@/lib/pageEvents";
import type { ReconcileFileError, VaultFreshnessChanged } from "@/types";
import { NotificationCard } from "./NotificationCard";

/** A pass of the space against its files ended (commands/freshness.rs). */
export const VAULT_FRESHNESS_CHANGED_EVENT = "vault-freshness-changed";

/** How many notes the notice names; the rest it counts. */
export const INDEX_ERRORS_SHOWN = 5;

export function indexErrorsTitle(count: number): string {
  return count === 1 ? "Could not read 1 note" : `Could not read ${count} notes`;
}

/** The quiet line: what the space shows meanwhile. */
export const INDEX_ERRORS_SUMMARY = "Mine shows the space without them.";

export function indexErrorsMoreText(count: number): string {
  return `And ${count} more.`;
}

function noteName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function setKey(files: readonly ReconcileFileError[]): string {
  return files.map((file) => file.path).sort().join("\n");
}

export function IndexErrorsNotice() {
  const [files, setFiles] = useState<readonly ReconcileFileError[]>([]);
  const [closedWith, setClosedWith] = useState<string | null>(null);

  useEffect(() => {
    const stop = listenPage<VaultFreshnessChanged>(VAULT_FRESHNESS_CHANGED_EVENT, (event) => {
      // A pass that failed as a whole says nothing of single notes: the
      // last list stands until a pass reads them again.
      if (event.payload.state === "failed") return;
      setFiles(event.payload.error_files);
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  const key = setKey(files);
  if (files.length === 0 || closedWith === key) return null;
  const shown = files.slice(0, INDEX_ERRORS_SHOWN);
  const more = files.length - shown.length;
  return (
    <div data-index-errors-notice="">
      <NotificationCard title={indexErrorsTitle(files.length)} onClose={() => setClosedWith(key)}>
        <p className="text-sm text-muted-foreground">{INDEX_ERRORS_SUMMARY}</p>
        {shown.map((file) => (
          <p key={file.path} className="text-sm text-destructive" title={file.path}>
            {`“${noteName(file.path)}”: ${file.message}`}
          </p>
        ))}
        {more > 0 && <p className="text-sm text-muted-foreground">{indexErrorsMoreText(more)}</p>}
      </NotificationCard>
    </div>
  );
}
