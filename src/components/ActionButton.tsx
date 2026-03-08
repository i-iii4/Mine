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
          "action-button group inline-flex h-6 shrink-0 cursor-pointer items-center rounded-1 pr-[2px] font-mono text-sm",
          "select-none overflow-hidden outline-0",
          isSelected
            ? "bg-primary-hover"
            : "bg-muted hover:bg-primary-hover",
          className,
        )}
      >
        {hotkey ? (
          <span className={cn(
            "shrink-0 px-[1ch] py-[2px]",
            isSelected
              ? "text-background"
              : "text-foreground group-hover:text-background",
          )}>
            {hotkey}
          </span>
        ) : null}
        <span className="shrink-0 rounded-1 bg-active px-[1ch] py-[2px] text-foreground">
          {children}
        </span>
      </div>
    );
  },
);

ActionButton.displayName = "ActionButton";
