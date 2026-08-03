import * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
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
        {/* The fill sits on the hotkey: it is the fixed, glyph-like half of the
            pair, and enclosing it reads as a key cap. The action name is prose
            and stays unenclosed. */}
        {hotkey ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-[2px] bg-component-fill-inner px-[1ch] leading-none text-foreground">
            {hotkey}
          </span>
        ) : null}
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center px-[1ch] leading-none",
            "text-foreground",
          )}
        >
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
    // One interactive element for the whole pair. The visual button is a span
    // inside it, not a nested <button>: the action name is part of the target,
    // so making the frame the only clickable thing would leave half the control
    // dead to the pointer.
    const frame = (
      <span
        aria-hidden="true"
        className={cn(
          buttonVariants({ variant: "default", size: "xs" }),
          // Height matches the inner pill of the other presentation, so the two
          // variants sit on the same baseline in the bar.
          "h-5 font-mono font-normal",
          // The hotkey is reference material at rest and comes forward only
          // when the pointer is anywhere on the pair — hence group-hover, not
          // hover on the frame itself.
          "text-muted-foreground group-hover:text-foreground",
          "group-hover:outline-1 group-hover:-outline-offset-1 group-hover:outline-component-fill-hover",
          isSelected && "bg-active",
        )}
      >
        {hotkey ?? children}
      </span>
    );

    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        data-action-button="standard"
        data-selected={isSelected ? "true" : undefined}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); }}
        className={cn(
          "group inline-flex shrink-0 cursor-pointer select-none items-center outline-0",
          hotkey && "gap-2",
          // Separates this pair from the next control. Without it the label
          // runs into the following button and stops reading as one group: the
          // bar's own gap is the same size as the gap inside the pair.
          "mr-2",
          className,
        )}
      >
        {frame}
        {hotkey ? (
          // Deliberately static on hover: the label already names the action,
          // and lighting both halves at once turns the pair into a blinking
          // block instead of one control.
          <span className="whitespace-nowrap font-mono text-sm text-muted-foreground">
            {children}
          </span>
        ) : null}
      </div>
    );
  },
);

StandardActionButton.displayName = "StandardActionButton";
