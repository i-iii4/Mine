import * as React from "react";
import { cn } from "@/lib/utils";

type SegmentedControlSize = "compact" | "default" | "clipper";

export type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

interface SegmentedControlProps<T extends string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  value: T;
  options: readonly SegmentedControlOption<T>[];
  onChange: (value: T) => void;
  "aria-label": string;
  size?: SegmentedControlSize;
}

const segmentedControlSizeClasses: Record<
  SegmentedControlSize,
  { root: string; item: string }
> = {
  compact: {
    root: "h-6 font-mono text-sm",
    item: "h-5",
  },
  default: {
    root: "h-8 text-base",
    item: "h-6",
  },
  clipper: {
    root: "h-8 text-base",
    item: "h-7",
  },
};

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "compact",
  className,
  ...props
}: SegmentedControlProps<T>) {
  const sizeClasses = segmentedControlSizeClasses[size];

  return (
    <div
      role="group"
      className={cn(
        "action-button inline-flex shrink-0 items-center overflow-hidden rounded-1 bg-transparent p-[2px] text-muted-foreground outline-0 hover:bg-active",
        sizeClasses.root,
        className,
      )}
      {...props}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex shrink-0 items-center rounded-[2px] px-[1ch] leading-none text-current focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
            sizeClasses.item,
            value === option.value && "bg-component-fill-inner text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
