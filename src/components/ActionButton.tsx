import * as React from "react";
import { cn } from "@/lib/utils";

interface ActionButtonProps {
  onClick?: () => void;
  hotkey?: string;
  children?: React.ReactNode;
  isSelected?: boolean;
  className?: string;
}

export const ActionButton = React.forwardRef<HTMLDivElement, ActionButtonProps>(
  ({ onClick, hotkey, children, isSelected, className }, ref) => {
    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); }}
        className={cn(
          "action-button group inline-flex h-6 shrink-0 cursor-pointer items-center rounded-1 p-[2px] font-mono text-sm",
          "select-none overflow-hidden outline-0",
          isSelected
            ? "bg-component-fill-hover"
            : "bg-transparent hover:bg-component-fill-hover",
          className,
        )}
      >
        {hotkey ? (
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center px-[1ch] leading-none",
              "text-foreground",
            )}
          >
            {hotkey}
          </span>
        ) : null}
        <span className="inline-flex h-5 shrink-0 items-center rounded-[2px] bg-component-fill-inner px-[1ch] leading-none text-foreground">
          {children}
        </span>
      </div>
    );
  },
);

ActionButton.displayName = "ActionButton";
