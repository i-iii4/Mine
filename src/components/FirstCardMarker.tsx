// One sentence after the first saved card (О19).
//
// The product sells locality, and the moment to show it is the moment the
// person just got their first result: the card they saved is an ordinary file
// in the folder they chose, and Finder can prove it. Said once per space —
// the point is made or it is not, repetition would make it nagging.

import { Button } from "@/components/ui/button";
import { NotificationCard } from "@/components/NotificationCard";

interface FirstCardMarkerCardProps {
  /** The saved card's file name, shown so "a file" is concrete. */
  fileName: string;
  onReveal: () => void;
  onClose: () => void;
}

export function FirstCardMarkerCard({ fileName, onReveal, onClose }: FirstCardMarkerCardProps) {
  return (
    <NotificationCard title="This card is a file" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        “{fileName}” is already in your folder. Open it, move it or copy it
        with any app — same as everything you save from now on.
      </p>
      <div data-first-card-marker="">
        <Button size="sm" onClick={onReveal}>
          Reveal in Finder
        </Button>
      </div>
    </NotificationCard>
  );
}
