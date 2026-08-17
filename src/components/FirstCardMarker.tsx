// One sentence after the first saved card (О19).
//
// The product sells locality, and the moment to show it is the moment the
// person just got their first result: the card they saved is an ordinary file
// in the folder they chose, and Finder can prove it. Said once per space —
// the point is made or it is not, repetition would make it nagging.

import { FileCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FirstCardMarkerCardProps {
  /** The saved card's file name, shown so "a file" is concrete. */
  fileName: string;
  onReveal: () => void;
  onClose: () => void;
}

export function FirstCardMarkerCard({ fileName, onReveal, onClose }: FirstCardMarkerCardProps) {
  return (
    <div
      className="w-80 rounded-1 border border-border bg-card p-3 shadow-md"
      data-first-card-marker=""
    >
      <div className="flex items-start gap-2">
        <FileCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-foreground">Saved as a file</p>
          <p className="mt-1 text-sm text-muted-foreground">
            “{fileName}” now lives in your folder — a plain file you can open,
            move or back up with any tool. Everything you save works this way.
          </p>
          <div className="mt-2">
            <Button size="sm" onClick={onReveal}>
              Reveal in Finder
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          className="shrink-0"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
