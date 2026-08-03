import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useActionButtonStyle } from "@/lib/actionButtonStyle";

interface ActionButtonProps {
  onClick?: () => void;
  hotkey?: string;
  children?: React.ReactNode;
  isSelected?: boolean;
  className?: string;
}

/// Bottom-bar action, in one of two presentations (see lib/actionButtonStyle).
///
/// The variant is read from the root attribute rather than passed as a prop, so
/// call sites are identical for both and no site can end up on the wrong one.
export const ActionButton = React.forwardRef<HTMLDivElement, ActionButtonProps>(
  ({ onClick, hotkey, children, isSelected, className }, ref) => {
    const style = useActionButtonStyle();

    if (style === "standard") {
      return (
        <StandardActionButton
          ref={ref}
          onClick={onClick}
          hotkey={hotkey}
          isSelected={isSelected}
          className={className}
        >
          {children}
        </StandardActionButton>
      );
    }

    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        data-action-button="pill"
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); }}
        className={cn(
          "action-button group inline-flex h-6 shrink-0 cursor-pointer items-center rounded-1 p-[2px] font-mono text-sm",
          "select-none overflow-hidden outline-0",
          isSelected
            ? "bg-active"
            : "bg-transparent hover:bg-active",
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

/// Standard presentation: the design-system `Button` carries the hotkey, the
/// action name sits beside it as plain text. Hover, focus and activation are
/// whatever `Button` already does — nothing is redefined here.
///
/// Without a hotkey there is nothing to put inside the button, so the label
/// moves in and the pair collapses to a plain labelled button.
const StandardActionButton = React.forwardRef<HTMLDivElement, ActionButtonProps>(
  ({ onClick, hotkey, children, isSelected, className }, ref) => {
    const button = (
      <Button
        size="xs"
        variant="default"
        onClick={onClick}
        data-selected={isSelected ? "true" : undefined}
        className={cn(
          // Height matches the inner pill of the other presentation, so the two
          // variants sit on the same baseline in the bar.
          "h-5 font-mono font-normal",
          // The hotkey is reference material at rest and only comes forward
          // under the pointer.
          "text-muted-foreground hover:text-foreground",
          isSelected && "bg-active",
        )}
      >
        {hotkey ?? children}
      </Button>
    );

    return (
      <div
        ref={ref}
        data-action-button="standard"
        className={cn(
          "inline-flex shrink-0 items-center",
          hotkey && "gap-2",
          className,
        )}
      >
        {button}
        {hotkey ? (
          <span className="select-none whitespace-nowrap font-mono text-sm text-muted-foreground">
            {children}
          </span>
        ) : null}
      </div>
    );
  },
);

StandardActionButton.displayName = "StandardActionButton";
