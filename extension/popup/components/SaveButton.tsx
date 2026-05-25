import { Button } from "@/components/ui/button";

interface SaveButtonProps {
  count: number;
  saving: boolean;
  onClick: () => void;
}

export function SaveButton({ count, saving, onClick }: SaveButtonProps) {
  if (saving) {
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

  const label =
    count === 0 ? "Save" : count === 1 ? "Save to 1 channel" : `Save to ${count} channels`;

  return (
    <Button size="clipper" onClick={onClick} className="w-full">
      <span>{label}</span>
    </Button>
  );
}
