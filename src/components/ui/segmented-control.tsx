import * as React from "react";
import { cn } from "@/lib/utils";
import { ChromeControl, ChromePlate } from "./chrome-control";

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
  chrome?: boolean;
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
  chrome = false,
  className,
  ...props
}: SegmentedControlProps<T>) {
  const sizeClasses = segmentedControlSizeClasses[size];

  return (
    <div
      role="group"
      className={cn(
        "action-button group/segments relative inline-flex shrink-0 items-center overflow-hidden rounded-1 bg-transparent text-muted-foreground outline-0",
        // The chrome plate stands beside the segments: the group publishes it
        // as their surface in the same states (state-surface).
        chrome ? "chrome-control px-[2px] font-mono text-sm hover:state-surface focus-within:state-surface" : cn("p-[2px] hover:state-active", sizeClasses.root),
        className,
      )}
      {...props}
    >
      {chrome && <ChromePlate aria-hidden="true" className="pointer-events-none absolute inset-x-0 rounded-1 group-hover/segments:state-active group-focus-within/segments:state-active" />}
      {options.map((option) => (
        <ChromeControl key={option.value} enabled={chrome}>
        <button
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "relative inline-flex shrink-0 items-center rounded-[2px] leading-none text-current focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:text-tertiary-foreground",
            !chrome && cn("px-[1ch]", sizeClasses.item, value === option.value && "bg-component-fill-inner text-foreground"),
          )}
        >
          {chrome ? <span className={cn("inline-flex h-5 items-center rounded-[2px] px-[1ch]", value === option.value && "bg-component-fill-inner text-foreground")}>{option.label}</span> : option.label}
        </button>
        </ChromeControl>
      ))}
    </div>
  );
}
