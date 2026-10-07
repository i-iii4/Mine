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
  return (
    <Tabs value={current} onValueChange={choose} className="gap-0">
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
