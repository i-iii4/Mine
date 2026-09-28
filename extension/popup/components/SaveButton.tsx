import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

export type SaveButtonState = "idle" | "saving" | "saved";

interface SaveButtonProps {
  count: number;
  state: SaveButtonState;
  onClick: () => void;
  checkingOutcome?: boolean;
  disabled?: boolean;
}

export function SaveButton({ count, state, onClick, checkingOutcome = false, disabled = false }: SaveButtonProps) {
  if (state === "saving") {
    // The design system's indeterminate Progress takes the button's place
    // while save is in flight: the native host reports no percentage. It
    // keeps the button's body so the bar sits exactly where the button was.
    return (
      <Progress
        value={null}
        aria-label="Saving"
        className="h-10 rounded-1 bg-component-fill"
        indicatorClassName="rounded-1 bg-component-fill-hover"
      />
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

  const label = checkingOutcome ? "Retry" :
    count === 0 ? "Save" : count === 1 ? "Save to 1 collection" : `Save to ${count} collections`;

  return (
    <Button size="clipper" onClick={onClick} disabled={disabled} className="w-full">
      <span>{label}</span>
    </Button>
  );
}
