import { Maximize2, Minimize2 } from "lucide-react";

// Every lucide icon is drawn 13 px on its 24-unit grid with a 1 px line
// (DESIGN_SYSTEM.md, «Иконки»). The arrows span 18 units of the grid (3 to 21)
// and the close cross beside them only 12 (6 to 18), so at one size the
// arrows read half again as large. They are drawn at the cross's extent
// instead, with the line kept at 1 px (user's decision of 30.10.2026).
const ICON_PX = 13;
const ICON_GRID = 24;
const CROSS_EXTENT = 12;
const ARROWS_EXTENT = 18;
const ARROWS_PX = (ICON_PX * CROSS_EXTENT) / ARROWS_EXTENT;
const ARROWS_STYLE = {
  width: ARROWS_PX,
  height: ARROWS_PX,
  strokeWidth: ICON_GRID / ARROWS_PX,
};

/** The card's way between its window and the full page (SPEC_CARD_PEEK.md,
 *  О9): arrows out to open full page, arrows in to go back to the window. */
export function ViewToggleIcon({ to }: { to: "full" | "window" }) {
  const Icon = to === "full" ? Maximize2 : Minimize2;
  return <Icon style={ARROWS_STYLE} data-view-toggle-icon={to} />;
}
