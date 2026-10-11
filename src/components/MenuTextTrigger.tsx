import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChromeControl, ChromePlate } from "./ui/chrome-control";
import { FadeText } from "./ui/fade-text";

type MenuTextTriggerSurface = "topChrome" | "clipperHeader" | "actionBar";

interface MenuTextTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  surface?: MenuTextTriggerSurface;
  hotkey?: string;
  keyboardFocus?: boolean;
  showChevron?: boolean;
  /** Radix's menu state, handed down through `DropdownMenuTrigger asChild`. */
  "data-state"?: string;
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
      "data-state": menuState,
      ...props
    },
    ref,
  ) => {
    const isClipperHeader = surface === "clipperHeader";
    const Plate = surface === "topChrome" ? ChromePlate : "span";
    const innerTextClass = surface === "clipperHeader" ? "text-foreground" : "text-muted-foreground";
    // A 13 px chevron is drawn in the middle of its box, about 4 px of
    // nothing on each side. With a chevron the pill drops the gap before it
    // and half its right padding, so it looks as tight to the name and as far
    // from the edge as the name is from the left one (DESIGN_SYSTEM.md,
    // «Иконка рядом с текстом»).
    const chevronPadding = showChevron ? "gap-0 pl-2 pr-1" : "gap-1 px-2";

    return (
      <ChromeControl enabled={surface === "topChrome"}>
      <button
        ref={ref}
        type="button"
        data-state={menuState}
        className={cn(
          "group select-none bg-transparent outline-0",
          surface === "topChrome" &&
            "inline-flex min-w-0 flex-none items-center overflow-hidden rounded-0 font-mono text-sm text-muted-foreground focus-visible:outline-none",
          surface === "clipperHeader" &&
            cn(
              "inline-flex h-6 min-w-0 max-w-full items-center overflow-hidden rounded-1 text-base text-foreground hover:state-active data-[state=open]:state-active",
              chevronPadding,
            ),
          surface === "actionBar" &&
            "action-button inline-flex h-6 shrink-0 items-center overflow-hidden rounded-1 p-[2px] font-mono text-sm hover:state-active",
          className,
        )}
        // In a chrome strip the name may dissolve: the whole of it shows on
        // hover, as a tab's does (DESIGN_SYSTEM.md, «Растворение кромок»).
        title={surface === "actionBar" ? undefined : label}
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
            <Plate
              className={cn(
                // The name dissolves before the chevron, as in the top
                // chrome: it shrinks only as a flex item, so the clipper's
                // plain plate is the flex box ChromePlate is. An inline name
                // ignored its box, ran over the chevron and was cut
                // mid-letter at the button's edge, flush with "…" (11.10.2026).
                isClipperHeader
                  ? "inline-flex min-w-0 max-w-full items-center"
                  : cn(
                    "min-w-0 max-w-full rounded-1 group-hover:state-active group-hover:text-foreground group-data-[state=open]:state-active group-data-[state=open]:text-foreground",
                    chevronPadding,
                  ),
                innerTextClass,
                keyboardFocus && "state-active text-foreground",
              )}
            >
              {/* A name that does not fit dissolves with the tab's mask, not
                  an ellipsis; the mask is on the text alone, so the plate
                  and the chevron stay whole (DESIGN_SYSTEM.md, «Растворение
                  кромок», 11.10.2026). */}
              <FadeText text={label} className="text-left" />
              {/* In the top chrome the chevron sits inside the pill, right
                  after the name, and lights up with it. Closed it points
                  right and turns down as the menu opens, as in the clipper. */}
              {showChevron && surface === "topChrome" ? (
                <ChevronRight
                  data-menu-chevron=""
                  className="size-[13px] shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                />
              ) : null}
            </Plate>
            {showChevron && isClipperHeader ? (
              <ChevronRight className="size-[13px] shrink-0 text-muted-foreground transition-transform duration-150 group-hover:text-foreground group-data-[state=open]:rotate-90 group-data-[state=open]:text-foreground" />
            ) : null}
          </>
        )}
      </button>
      </ChromeControl>
    );
  },
);

MenuTextTrigger.displayName = "MenuTextTrigger";
