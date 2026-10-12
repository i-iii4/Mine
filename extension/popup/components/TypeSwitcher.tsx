import type { ClipType } from "../hooks/useClipperState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TypeSwitcherProps {
  current: ClipType;
  onChange: (type: ClipType) => void;
}

const TYPES: readonly { value: ClipType; label: string }[] = [
  { value: "content", label: "Content" },
  { value: "screenshot", label: "Screenshot" },
  { value: "link", label: "Link" },
];

export function TypeSwitcher({ current, onChange }: TypeSwitcherProps) {
  const choose = (next: string) => {
    const type = TYPES.find((option) => option.value === next);
    if (type) onChange(type.value);
  };
  // A press, Enter or Space picks a type; the arrows pick it in PopupApp.
  // Focus alone never does: a type change takes a screenshot or reads the
  // page, and the keyboard returned to a segment after the overlay was
  // hidden for a capture must not pick that segment's type again
  // (SPEC_CLIPPER.md, «Доработки после живого просмотра», 12.10.2026).
  return (
    <Tabs value={current} onValueChange={choose} activationMode="manual" className="gap-0">
      <TabsList
        variant="chrome"
        size="panel"
        aria-label="Save type"
        className="max-w-full"
        data-clipper-type-switcher=""
      >
        {TYPES.map((type) => (
          <TabsTrigger key={type.value} value={type.value}>{type.label}</TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
