import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { channelIconBoxStyle } from "@/lib/channelIcon";

// The PLAN 7.23 stack of mini-cards, the previews of a compact sidebar item;
// its geometry lives in src/lib/channelIcon.ts.

/** The mini-card's own look: square (user's decision of 22.10.2026: sharp
 *  corners, as the table's), on the feed skeleton's fill, with the light
 *  shadow of the floating layers' scale (К11, `shadow-sm`). Its edge is the
 *  buttons' (К10), drawn over the image by global.css («Compact rows»). */
export const CHANNEL_ICON_CARD_CLASS = "absolute top-0 overflow-hidden rounded-0 bg-accent shadow-sm";

/** The stack's box; the cards inside are placed by `channelIconCardStyle`. */
export function ChannelIcon({
  card,
  style,
  className,
  ...props
}: ComponentProps<"span"> & { card?: number }) {
  return (
    <span
      {...props}
      className={cn("relative shrink-0", className)}
      style={{ ...style, ...channelIconBoxStyle(card) }}
      data-channel-icon=""
    />
  );
}
