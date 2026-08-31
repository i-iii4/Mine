import { Button } from "@/components/ui/button";

export type SaveButtonState = "idle" | "saving" | "saved";

interface SaveButtonProps {
  count: number;
  state: SaveButtonState;
  onClick: () => void;
  checkingOutcome?: boolean;
}

export function SaveButton({ count, state, onClick, checkingOutcome = false }: SaveButtonProps) {
  if (state === "saving") {
    // Indeterminate progress bar replaces the button while save is in
    // flight. Native host doesn't report percentage, so we animate a
    // sliding indicator via mine-progress-indicator keyframe defined
    // in popup-layout.css.
    return (
      <div className="relative h-10 w-full overflow-hidden rounded-1 bg-component-fill">
        <div className="mine-progress-indicator absolute inset-y-0 left-0 w-1/3 bg-component-fill-hover" />
      </div>
    );
  }

  if (state === "saved") {
    // Success lives on the button itself — the app has no green status
    // strip, and the clipper closes a beat later anyway.
    return (
      <Button size="clipper" disabled className="w-full" data-clipper-saved="">
        Saved
      </Button>
    );
  }

  const label = checkingOutcome ? "Check save outcome" :
    count === 0 ? "Save" : count === 1 ? "Save to 1 collection" : `Save to ${count} collections`;

  return (
    <Button size="clipper" onClick={onClick} className="w-full">
      <span>{label}</span>
    </Button>
  );
}
