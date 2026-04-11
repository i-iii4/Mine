import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PopupApp } from "./PopupApp";

interface OverlayShellProps {
  onClose: () => void;
}

/**
 * Container for the in-page overlay version of the clipper.
 *
 * Positions the clipper UI top-right of the viewport, matches the width
 * of the detached popup window (360px), adds an explicit close button
 * (no OS window chrome to click outside of). Hosts the existing
 * <PopupApp /> unchanged — same state, same behaviour.
 *
 * Esc closes the overlay in addition to PopupApp's own Esc handler
 * (which calls window.close() — a no-op inside a Shadow DOM).
 */
export function OverlayShell({ onClose }: OverlayShellProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  return (
    <div className="fixed right-4 top-4 w-[360px] rounded-1 border border-border bg-background shadow-[0_4px_24px_rgba(0,0,0,0.4)]">
      <div className="absolute right-2 top-2 z-10">
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X />
        </Button>
      </div>
      <PopupApp />
    </div>
  );
}
