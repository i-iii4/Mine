// Whether the top row over the feed cannot hold the selection's commands
// (SPEC_NARROW_WINDOW.md, У10). Only they take a second row: an open card's
// name and actions, the view switch, the place, the space and the graph's
// controls shrink with an ellipsis as they always did and never send
// anything to a second row. A truncated text alone moves nothing either.
//
// The half over the feed (`data-top-row-bar`) stacks crossfading layers
// (`data-entered`); the layer that may take a second row says so with
// `data-top-row-wraps`. In it, `data-top-row-part="whole"` marks the group
// that never shrinks: the row does not hold it when it stands past an edge
// of the half. While any other layer of the half is on screen (an open
// card's name over a selection), the row holds whatever it shows.

/** The attribute that marks the selection's group of commands. */
export const TOP_ROW_PART_ATTRIBUTE = "data-top-row-part";

/** The half over the feed: the box the group is measured against. */
export const TOP_ROW_BAR_ATTRIBUTE = "data-top-row-bar";

/** The layer of the half that may take a second row. */
export const TOP_ROW_WRAPS_ATTRIBUTE = "data-top-row-wraps";

/** Less than a pixel past an edge is rounding, not a cut. */
const EDGE_TOLERANCE_PX = 0.5;

function pastEdge(part: Element, bound: DOMRect): boolean {
  const box = part.getBoundingClientRect();
  return box.left < bound.left - EDGE_TOLERANCE_PX || box.right > bound.right + EDGE_TOLERANCE_PX;
}

/** Whether `row` cuts the selection's commands on screen. Reads layout. */
export function topRowCut(row: Element): boolean {
  const bar = row.querySelector(`[${TOP_ROW_BAR_ATTRIBUTE}]`);
  if (!bar) return false;
  const entered = [...bar.children].filter((layer) => layer.getAttribute("data-entered") === "true");
  if (entered.length === 0 || entered.some((layer) => !layer.hasAttribute(TOP_ROW_WRAPS_ATTRIBUTE))) {
    return false;
  }
  const bound = bar.getBoundingClientRect();
  return entered.some((layer) => [...layer.querySelectorAll(`[${TOP_ROW_PART_ATTRIBUTE}="whole"]`)]
    .some((part) => pastEdge(part, bound)));
}
