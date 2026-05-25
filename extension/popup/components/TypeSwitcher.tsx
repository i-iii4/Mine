import type { ClipType } from "../hooks/useClipperState";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";

interface TypeSwitcherProps {
  current: ClipType;
  onChange: (type: ClipType) => void;
}

const TYPES: SegmentedControlOption<ClipType>[] = [
  { value: "content", label: "Content" },
  { value: "screenshot", label: "Screenshot" },
  { value: "link", label: "Link" },
];

export function TypeSwitcher({ current, onChange }: TypeSwitcherProps) {
  return (
    <SegmentedControl
      value={current}
      options={TYPES}
      onChange={onChange}
      size="clipper"
      aria-label="Clip type"
      className="w-fit max-w-full"
      data-clipper-type-switcher=""
    />
  );
}
