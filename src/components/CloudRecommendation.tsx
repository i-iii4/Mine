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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NotificationAnchor, NotificationCard } from "@/components/NotificationCard";
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
    <NotificationAnchor>
      <div data-cloud-recommendation="">
        <CloudRecommendationCard
          neverAgain={neverAgain}
          onNeverAgainChange={setNeverAgain}
          onReveal={() => void revealItemInDir(vaultPath)}
          onClose={close}
        />
      </div>
    </NotificationAnchor>
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
    <div data-cloud-recommendation-card="">
      <NotificationCard
        title="Cards keep arriving slowly"
        onClose={onClose}
        closeLabel="Dismiss recommendation"
      >
        <p className="text-sm text-muted-foreground">
          macOS keeps this space’s files in iCloud and downloads them on
          demand. To keep them on this Mac: right-click the space’s folder in
          Finder and choose <span className="text-popover-foreground">Keep
          Downloaded</span>. This is a system setting — Mine cannot turn it on
          for you.
        </p>
        <p className="text-sm text-muted-foreground">
          Turning off <span className="text-popover-foreground">Optimise Mac
          Storage</span> in System Settings does the same for all of iCloud
          Drive, not just this space.
        </p>
        <div>
          <Button size="sm" onClick={onReveal}>
            Show folder in Finder
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={neverAgain}
            onCheckedChange={(value) => onNeverAgainChange(value === true)}
          />
          Don’t show again
        </label>
      </NotificationCard>
    </div>
  );
}
