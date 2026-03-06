import { Button } from "@/components/ui/button";
import type { ClipType } from "../hooks/useClipperState";
import { cn } from "@/lib/utils";

interface TypeSwitcherProps {
  current: ClipType;
  onChange: (type: ClipType) => void;
}

const TYPES: { value: ClipType; label: string }[] = [
  { value: "content", label: "Content" },
  { value: "link", label: "Link" },
];

export function TypeSwitcher({ current, onChange }: TypeSwitcherProps) {
  return (
    <div className="flex rounded-1 border border-border p-0.5">
      {TYPES.map(({ value, label }) => (
        <Button
          key={value}
          variant="ghost"
          size="xs"
          onClick={() => onChange(value)}
          className={cn(
            "flex-1 rounded-[2px] text-sm text-muted-foreground",
            current === value && "bg-muted text-foreground",
          )}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
