import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type MenuTextTriggerSurface = "topChrome" | "clipperHeader" | "actionBar";

interface MenuTextTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: React.ReactNode;
  surface?: MenuTextTriggerSurface;
  hotkey?: string;
  keyboardFocus?: boolean;
  showChevron?: boolean;
}

export const MenuTextTrigger = React.forwardRef<HTMLButtonElement, MenuTextTriggerProps>(
  (
    {
      label,
      surface = "topChrome",
      hotkey,
      keyboardFocus = false,
      showChevron = false,
      className,
      ...props
    },
    ref,
  ) => {
    const chromeLike = surface === "topChrome" || surface === "clipperHeader";
    const isClipperHeader = surface === "clipperHeader";
    const innerTextClass = surface === "clipperHeader" ? "text-foreground" : "text-muted-foreground";

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "group cursor-pointer select-none bg-transparent outline-0",
          surface === "topChrome" &&
            "inline-flex h-full min-w-0 flex-none items-center overflow-hidden rounded-0 font-mono text-sm text-muted-foreground focus-visible:outline-none",
          surface === "clipperHeader" &&
            "inline-flex h-6 max-w-full items-center gap-1 overflow-hidden rounded-1 px-2 text-base text-foreground hover:bg-active data-[state=open]:bg-active",
          surface === "actionBar" &&
            "action-button inline-flex h-6 shrink-0 items-center overflow-hidden rounded-1 p-[2px] font-mono text-sm hover:bg-component-fill-hover",
          className,
        )}
        {...props}
      >
        {surface === "actionBar" ? (
          <>
            {hotkey ? (
              <span className="shrink-0 px-[1ch] py-[2px] text-foreground">
                {hotkey}
              </span>
            ) : null}
            <span className="min-w-0 shrink-0 truncate rounded-[2px] bg-component-fill-inner px-[1ch] py-[2px] text-foreground">
              {label}
            </span>
          </>
        ) : (
          <>
            <span
              className={cn(
                isClipperHeader
                  ? "min-w-0 max-w-full"
                  : "inline-flex h-6 min-w-0 max-w-full items-center rounded-1 px-2 group-hover:bg-active group-hover:text-foreground group-data-[state=open]:bg-active group-data-[state=open]:text-foreground",
                innerTextClass,
                keyboardFocus && "bg-active text-foreground",
              )}
            >
              <span className="min-w-0 truncate text-left">
                {label}
              </span>
            </span>
            {showChevron && chromeLike ? (
              isClipperHeader ? (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:text-foreground group-data-[state=open]:rotate-90 group-data-[state=open]:text-foreground" />
              ) : (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground group-data-[state=open]:text-foreground" />
              )
            ) : null}
          </>
        )}
      </button>
    );
  },
);

MenuTextTrigger.displayName = "MenuTextTrigger";
