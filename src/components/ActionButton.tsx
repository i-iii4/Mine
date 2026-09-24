import * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ChromeControl } from "./ui/chrome-control";

interface ActionButtonProps {
  onClick?: () => void;
  hotkey?: string;
  children?: React.ReactNode;
  isSelected?: boolean;
  className?: string;
  chrome?: boolean;
  /// A reference entry rather than a control: it names a keystroke the user
  /// performs on the keyboard, and clicking it would do nothing. Such an entry
  /// is not focusable and is not announced as a button.
  readOnly?: boolean;
}

/// Bottom bar action with one standard presentation.
export const ActionButton = React.forwardRef<HTMLDivElement, ActionButtonProps>(
  ({ onClick, hotkey, children, isSelected, className, readOnly, chrome = false }, ref) => {
    return (
      <StandardActionButton
        ref={ref}
        onClick={onClick}
        hotkey={hotkey}
        isSelected={isSelected}
        className={className}
        readOnly={readOnly}
        chrome={chrome}
      >
        {children}
      </StandardActionButton>
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
  ({ onClick, hotkey, children, isSelected, className, readOnly, chrome = false }, ref) => {
    // One interactive element for the whole pair. The visual button is a span
    // inside it, not a nested <button>: the action name is part of the target,
    // so making the frame the only clickable thing would leave half the control
    // dead to the pointer.
    const frame = (
      <span
        aria-hidden={Boolean(hotkey)}
        className={cn(
          buttonVariants({ variant: readOnly ? "reference" : "default", size: "xs" }),
          // The key frame keeps the same 20px baseline across bar entries.
          "h-5 font-mono font-normal",
          // The hotkey is reference material at rest and comes forward only
          // when the pointer is anywhere on the pair — hence group-hover, not
          // hover on the frame itself. A read-only entry has nothing to come
          // forward for: it cannot be pressed, and answering the pointer would
          // promise that it can.
          "text-muted-foreground",
          !readOnly && "group-hover:text-foreground",
          !readOnly && "group-hover:outline-1 group-hover:-outline-offset-1 group-hover:outline-component-fill-hover",
          isSelected && "bg-active",
        )}
      >
        {hotkey ?? children}
      </span>
    );

    return (
      <ChromeControl enabled={chrome && !readOnly}>
      <div
        ref={ref}
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? undefined : 0}
        data-action-button="standard"
        data-action-button-readonly={readOnly ? "true" : undefined}
        data-selected={isSelected ? "true" : undefined}
        onClick={readOnly ? undefined : onClick}
        onKeyDown={readOnly
          ? undefined
          : (e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); }}
        className={cn(
          "group inline-flex shrink-0 select-none items-center outline-0",
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
      </ChromeControl>
    );
  },
);

StandardActionButton.displayName = "StandardActionButton";
