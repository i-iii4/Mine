// The first index, counted out loud (О13).
//
// A large space takes real time to index, and during that time the feed has
// nothing to show. Silence here reads as "hung" and an endless spinner reads
// as "busy with who knows what" — numbers are the only honest option: they
// move, and they say how much is left. This replaces the empty-space
// onboarding while the first pass runs, because "this space is empty" is a
// falsehood about a space that is still being read.

import { Progress } from "@/components/ui/progress";

interface IndexingProgressProps {
  /** The space's folder name — the thing being indexed, by name. */
  spaceName: string;
  processed: number;
  total: number;
}

export function IndexingProgress({ spaceName, processed, total }: IndexingProgressProps) {
  const share = total > 0 ? Math.min(processed / total, 1) : 0;
  const shown = Math.min(processed, total);
  // A screen reader hears the progress in tenths: every count would talk
  // over everything else, silence would read as hung (А6.14).
  const tenths = Math.floor(share * 10) * 10;
  return (
    <div
      className="grid h-full min-h-80 place-items-center"
      data-indexing-progress=""
    >
      <div className="grid w-80 gap-2">
        <div className="flex items-baseline justify-between">
          <p className="text-base text-foreground">Indexing “{spaceName}”</p>
          <p className="font-mono text-sm text-muted-foreground" data-indexing-progress-count="">
            {processed} / {total}
          </p>
        </div>
        {/* The shared bar draws the share as a percentage; a screen reader
            hears the count itself, so the count overrides the percentage the
            primitive would announce. */}
        <Progress
          value={share * 100}
          aria-label={`Indexing “${spaceName}”`}
          aria-valuemax={total}
          aria-valuenow={shown}
          aria-valuetext={`${shown} of ${total}`}
        />
        <p className="sr-only" role="status" aria-live="polite" data-indexing-progress-announcement="">
          {`Indexing “${spaceName}”: ${tenths}%`}
        </p>
      </div>
    </div>
  );
}
