// Indexing, counted out loud in the notification corner (О13).
//
// A large space takes real time to index. Silence reads as "hung" and an
// endless spinner as "busy with who knows what": numbers are the honest
// option, they move and they say how much is left. The count lives in the
// corner where every notification lives, so it serves the first index of an
// empty feed and a long reindex under a full one alike, and covers nothing.
// It appears only once a pass has run for `INDEXING_NOTICE_DELAY_MS`: the
// short passes that follow every saved file would otherwise blink it.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { NotificationCard } from "@/components/NotificationCard";

/** How long a pass runs before the notice shows. */
export const INDEXING_NOTICE_DELAY_MS = 1000;

export interface IndexingCount {
  processed: number;
  total: number;
}

/**
 * Whether the indexing notice shows: a pass with a count that has run past the
 * delay and was not hidden. Hiding lasts until the pass ends.
 */
export function useIndexingNotice(count: IndexingCount | null): {
  visible: boolean;
  hide: () => void;
} {
  const active = count !== null;
  const [due, setDue] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!active) {
      setDue(false);
      setHidden(false);
      return;
    }
    const timer = window.setTimeout(() => setDue(true), INDEXING_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return { visible: active && due && !hidden, hide: () => setHidden(true) };
}

interface IndexingProgressProps {
  /** The space's folder name — the thing being indexed, by name. */
  spaceName: string;
  processed: number;
  total: number;
  onClose: () => void;
  /** The way out of a folder chosen by mistake, while the count shows what it
   *  holds: a folder opens without a confirmation step (О12). */
  onChooseAnother?: () => void;
}

export function IndexingProgress({ spaceName, processed, total, onClose, onChooseAnother }: IndexingProgressProps) {
  const share = total > 0 ? Math.min(processed / total, 1) : 0;
  const shown = Math.min(processed, total);
  // A screen reader hears the progress in tenths: every count would talk
  // over everything else, silence would read as hung (А6.14).
  const tenths = Math.floor(share * 10) * 10;
  return (
    <NotificationCard title={`Indexing “${spaceName}”`} onClose={onClose} closeLabel="Hide">
      <div className="grid gap-2" data-indexing-progress="">
        <div className="flex items-center gap-3">
          {/* The shared bar draws the share as a percentage; a screen reader
              hears the count itself, so the count overrides the percentage
              the primitive would announce. */}
          <Progress
            className="flex-1"
            value={share * 100}
            aria-label={`Indexing “${spaceName}”`}
            aria-valuemax={total}
            aria-valuenow={shown}
            aria-valuetext={`${shown} of ${total}`}
          />
          <p className="shrink-0 text-sm text-muted-foreground tabular-nums" data-indexing-progress-count="">
            {processed} / {total}
          </p>
        </div>
        <p className="sr-only" role="status" aria-live="polite" data-indexing-progress-announcement="">
          {`Indexing “${spaceName}”: ${tenths}%`}
        </p>
        {onChooseAnother && (
          <div>
            <Button variant="secondary" onClick={onChooseAnother}>
              Choose another folder
            </Button>
          </div>
        )}
      </div>
    </NotificationCard>
  );
}
