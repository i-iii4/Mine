// Opening a space, counted out loud in the notification corner (О13).
//
// A large space takes real time to open: first its notes are indexed, then
// their previews are prepared. Silence reads as "hung" and an endless
// spinner as "busy with who knows what": numbers are the honest option, they
// move and they say how much is left. The count lives in the corner where
// every notification lives, so it serves the first opening of an empty feed
// and a long reindex under a full one alike, and covers nothing. Both phases
// share one card: it changes its title from one phase to the next and never
// leaves the corner in between. It appears only once the opening has run for
// `INDEXING_NOTICE_DELAY_MS`, counted from the start of the first phase: the
// short passes that follow every saved file would otherwise blink it.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { NotificationCard } from "@/components/NotificationCard";

/** How long an opening runs before the notice shows. */
export const INDEXING_NOTICE_DELAY_MS = 1000;

export interface IndexingCount {
  processed: number;
  total: number;
}

/**
 * The two phases of an opening, in order: the notes are indexed, then the
 * previews of their cards are prepared.
 */
export type IndexingPhase = "notes" | "previews";

/** The phase running now, with its count; null while the phase is still counting what it has to do. */
export interface IndexingStep {
  phase: IndexingPhase;
  count: IndexingCount | null;
}

/**
 * The step the opening notice shows: the notes while their index pass counts
 * (`notes`), then the previews while a preview pass is pending, with its
 * count once the pass has counted its cards (`previews`); null once neither
 * runs. Notes come first even when a preview pass is already queued: the
 * cards whose previews it prepares are still being read.
 */
export function openingStep(
  notes: IndexingCount | null,
  previewsPending: boolean,
  previews: IndexingCount | null,
): IndexingStep | null {
  if (notes !== null) return { phase: "notes", count: notes };
  if (previewsPending) return { phase: "previews", count: previews };
  return null;
}

/**
 * Whether the opening notice shows: an opening that has run past the delay
 * and was not hidden. `active` must stay true from the first phase to the
 * last: the delay and hiding then span the whole opening, and a notice that
 * appeared for the notes stays up for the previews. Hiding lasts until the
 * opening ends.
 */
export function useIndexingNotice(active: boolean): {
  visible: boolean;
  hide: () => void;
} {
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
  // Stable, so a caller may hide the notice from an effect: a tab that starts
  // leading its space hides a notice the previous lead closed (SPEC_TABS.md, В20).
  const hide = useCallback(() => setHidden(true), []);
  return { visible: active && due && !hidden, hide };
}

/** The notice's title for a phase of opening `spaceName`. */
export function indexingTitle(phase: IndexingPhase, spaceName: string): string {
  return phase === "notes" ? `Indexing “${spaceName}”` : "Preparing previews";
}

interface IndexingProgressProps {
  /** The space's folder name: the thing being opened, by name. */
  spaceName: string;
  step: IndexingStep;
  onClose: () => void;
  /** The way out of a folder chosen by mistake, while the count shows what it
   *  holds: a folder opens without a confirmation step (О12). */
  onChooseAnother?: () => void;
}

/** The opening notice: one card in the corner for both phases (О13). */
export function IndexingProgress({ spaceName, step, onClose, onChooseAnother }: IndexingProgressProps) {
  const title = indexingTitle(step.phase, spaceName);
  const { count } = step;
  return (
    <NotificationCard title={title} onClose={onClose} closeLabel="Hide">
      <div className="grid gap-2" data-indexing-progress="" data-indexing-phase={step.phase}>
        {count === null ? <UncountedBar title={title} /> : <CountedBar title={title} count={count} />}
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

function CountedBar({ title, count: { processed, total } }: { title: string; count: IndexingCount }) {
  const share = total > 0 ? Math.min(processed / total, 1) : 0;
  const shown = Math.min(processed, total);
  // A screen reader hears the progress in tenths: every count would talk
  // over everything else, silence would read as hung (А6.14).
  const tenths = Math.floor(share * 10) * 10;
  return (
    <>
      <div className="flex items-center gap-3">
        {/* The shared bar draws the share as a percentage; a screen reader
            hears the count itself, so the count overrides the percentage
            the primitive would announce. */}
        <Progress
          className="flex-1"
          value={share * 100}
          aria-label={title}
          aria-valuemax={total}
          aria-valuenow={shown}
          aria-valuetext={`${shown} of ${total}`}
        />
        <p className="shrink-0 text-sm text-muted-foreground tabular-nums" data-indexing-progress-count="">
          {processed} / {total}
        </p>
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-indexing-progress-announcement="">
        {`${title}: ${tenths}%`}
      </p>
    </>
  );
}

/** The moment between phases while the next one counts its work: no number
 *  to show yet, and no made-up one either. */
function UncountedBar({ title }: { title: string }) {
  return (
    <>
      <Progress value={null} aria-label={title} />
      <p className="sr-only" role="status" aria-live="polite" data-indexing-progress-announcement="">
        {title}
      </p>
    </>
  );
}
