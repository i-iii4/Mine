// The first index, counted out loud (О13).
//
// A large space takes real time to index, and during that time the feed has
// nothing to show. Silence here reads as "hung" and an endless spinner reads
// as "busy with who knows what" — numbers are the only honest option: they
// move, and they say how much is left. This replaces the empty-space
// onboarding while the first pass runs, because "this space is empty" is a
// falsehood about a space that is still being read.

interface IndexingProgressProps {
  /** The space's folder name — the thing being indexed, by name. */
  spaceName: string;
  processed: number;
  total: number;
}

export function IndexingProgress({ spaceName, processed, total }: IndexingProgressProps) {
  const share = total > 0 ? Math.min(processed / total, 1) : 0;
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
        <div className="h-1 overflow-hidden rounded-full bg-component-fill">
          <div
            className="h-full bg-foreground transition-[width] duration-300"
            style={{ width: `${share * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
