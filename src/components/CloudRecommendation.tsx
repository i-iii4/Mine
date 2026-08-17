// The advice people otherwise find on a forum, brought by the app (Х18).
//
// Appears bottom-right, once per space, and only for someone who actually
// lives with the problem — waits repeated across sessions, not one visit to an
// old archive. The copy is honest about agency: Keep Downloaded is a macOS
// setting on the folder, the app cannot flip it, and the app says so instead
// of pretending. Closing binds the dismissal to this space; the checkbox
// silences the advice everywhere (Х19). See SPEC_CLOUD_STORAGE.md Х16–Х22.

import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Cloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  cloudRecommendationState,
  dismissCloudRecommendation,
} from "@/lib/commands";

interface CloudRecommendationProps {
  /** The active space; the card re-evaluates when it changes. */
  vaultPath: string;
  /** Bumped by the app when a sync pass lands — waits may have just repeated. */
  refreshToken?: number;
}

export function CloudRecommendation({ vaultPath, refreshToken = 0 }: CloudRecommendationProps) {
  const [due, setDue] = useState(false);
  const [neverAgain, setNeverAgain] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cloudRecommendationState()
      .then((state) => {
        if (!cancelled) setDue(state.due);
      })
      .catch(() => {
        // No answer, no card: the advice must never surface as an error.
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, refreshToken]);

  const close = useCallback(() => {
    setDue(false);
    void dismissCloudRecommendation(neverAgain).catch(() => {});
  }, [neverAgain]);

  if (!due) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40" data-cloud-recommendation="">
      <CloudRecommendationCard
        neverAgain={neverAgain}
        onNeverAgainChange={setNeverAgain}
        onReveal={() => void revealItemInDir(vaultPath)}
        onClose={close}
      />
    </div>
  );
}

/// The card itself, free of IPC, so the design-system showcase can draw it
/// with fixed inputs — the same split every other drawn state uses.
export function CloudRecommendationCard({
  neverAgain,
  onNeverAgainChange,
  onReveal,
  onClose,
}: {
  neverAgain: boolean;
  onNeverAgainChange: (value: boolean) => void;
  onReveal: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="w-80 rounded-1 border border-border bg-card p-3 shadow-md"
      data-cloud-recommendation-card=""
    >
      <div className="flex items-start gap-2">
        <Cloud className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-foreground">
            Cards keep arriving slowly
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            macOS keeps this space’s files in iCloud and downloads them on
            demand. To keep them on this Mac: right-click the space’s folder in
            Finder and choose <span className="text-foreground">Keep
            Downloaded</span>. This is a system setting — Mine cannot turn it on
            for you.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Turning off <span className="text-foreground">Optimise Mac
            Storage</span> in System Settings does the same for all of iCloud
            Drive, not just this space.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={onReveal}>
              Show folder in Finder
            </Button>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={neverAgain}
              onCheckedChange={(value) => onNeverAgainChange(value === true)}
            />
            Don’t show again
          </label>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss recommendation"
          className="shrink-0"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
