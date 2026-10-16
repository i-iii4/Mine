// A hovered collection keeps its own part of the graph and dims the rest
// (SPEC_GRAPH_VIEW.md, «Приглушение при наведении на коллекцию», user's
// decision of 16.10.2026).

import { describe, expect, it } from "vitest";
import { GRAPH_CONTEXT_OPACITY } from "@/lib/colorLaw";
import {
  beginDimTransition,
  colorAtOpacity,
  dimProgressAt,
  graphElementOpacity,
  graphHoverHighlight,
  restingDimTransition,
} from "./hoverDim";
import type { GraphCanvasLink, GraphCanvasNode } from "./contracts";

function link(
  id: string,
  kind: GraphCanvasLink["kind"],
  source: string,
  target: string,
): GraphCanvasLink {
  return { id, kind, source, target, directed: kind !== "collection_membership", count: 1, target_ref: null };
}

// Design holds a and b; Research holds c and a. Between the cards run a
// wikilink and a related note, and a links to the Design page by wikilink.
const LINKS: GraphCanvasLink[] = [
  link("m:design:a", "collection_membership", "collection:Design", "card:a"),
  link("m:design:b", "collection_membership", "collection:Design", "card:b"),
  link("m:research:c", "collection_membership", "collection:Research", "card:c"),
  link("m:research:a", "collection_membership", "collection:Research", "card:a"),
  link("w:a:b", "wikilink", "card:a", "card:b"),
  link("r:b:c", "related_note", "card:b", "card:c"),
  link("w:a:design", "wikilink", "card:a", "collection:Design"),
];

const DESIGN = { id: "collection:Design", kind: "collection" } as const;
const CARD_A = { id: "card:a", kind: "card" } as const;

describe("graphHoverHighlight", () => {
  it("keeps a hovered collection, its member cards and its membership lines, and nothing else", () => {
    const highlight = graphHoverHighlight(DESIGN, LINKS);
    expect(highlight && [...highlight.nodeIds].sort()).toEqual(["card:a", "card:b", "collection:Design"]);
    // Strict: the wikilink and the related note between its cards, a member's
    // membership in Research and a wikilink to the Design page are not counted.
    expect(highlight && [...highlight.linkIds].sort()).toEqual(["m:design:a", "m:design:b"]);
  });

  it("reads the endpoints whether d3 has replaced them with nodes or not, and either way round", () => {
    const nodes = new Map<string, GraphCanvasNode>(
      ["collection:Design", "card:a", "card:b"].map((id) => [id, { id } as GraphCanvasNode]),
    );
    const resolved = [
      { ...LINKS[0]!, source: nodes.get("collection:Design")!, target: nodes.get("card:a")! },
      { ...LINKS[1]!, source: "card:b", target: "collection:Design" },
    ];
    const highlight = graphHoverHighlight(DESIGN, resolved);
    expect(highlight && [...highlight.nodeIds].sort()).toEqual(["card:a", "card:b", "collection:Design"]);
    expect(highlight && [...highlight.linkIds].sort()).toEqual(["m:design:a", "m:design:b"]);
  });

  it("keeps only the collection itself when it has no members", () => {
    const highlight = graphHoverHighlight({ id: "collection:Empty", kind: "collection" }, LINKS);
    expect(highlight && [...highlight.nodeIds]).toEqual(["collection:Empty"]);
    expect(highlight && [...highlight.linkIds]).toEqual([]);
  });

  it("dims nothing for a hovered card or for no hover at all", () => {
    expect(graphHoverHighlight(CARD_A, LINKS)).toBeNull();
    expect(graphHoverHighlight(null, LINKS)).toBeNull();
  });
});

describe("graphElementOpacity", () => {
  const DIMMED = GRAPH_CONTEXT_OPACITY;
  // Half-way between lit and dimmed, and a quarter of the way back from there.
  const HALF = (1 + DIMMED) / 2;
  const THREE_QUARTERS = 1 - (1 - DIMMED) / 4;

  it("draws everything as it is while nothing is hovered", () => {
    const rest = restingDimTransition();
    expect(graphElementOpacity(rest, "node", "card:c", DIMMED)).toBe(1);
    expect(graphElementOpacity(rest, "link", "w:a:b", DIMMED)).toBe(1);
  });

  it("dims what is outside the hovered collection's part, once the fade has arrived", () => {
    const dimmed = beginDimTransition(restingDimTransition(), graphHoverHighlight(DESIGN, LINKS), 0, 0);
    expect(graphElementOpacity(dimmed, "node", "collection:Design", DIMMED)).toBe(1);
    expect(graphElementOpacity(dimmed, "node", "card:b", DIMMED)).toBe(1);
    expect(graphElementOpacity(dimmed, "node", "card:c", DIMMED)).toBeCloseTo(DIMMED);
    expect(graphElementOpacity(dimmed, "node", "collection:Research", DIMMED)).toBeCloseTo(DIMMED);
    expect(graphElementOpacity(dimmed, "link", "m:design:a", DIMMED)).toBe(1);
    expect(graphElementOpacity(dimmed, "link", "w:a:b", DIMMED)).toBeCloseTo(DIMMED);
    expect(graphElementOpacity(dimmed, "link", "m:research:a", DIMMED)).toBeCloseTo(DIMMED);
  });

  it("moves each element from where the previous hover put it to where the next one does", () => {
    const design = beginDimTransition(restingDimTransition(), graphHoverHighlight(DESIGN, LINKS), 0, 0);
    const research = beginDimTransition(
      design,
      graphHoverHighlight({ id: "collection:Research", kind: "collection" }, LINKS),
      1_000,
      150,
    );
    research.progress = 0.5;
    // b leaves the lit part, c joins it, a stays in both.
    expect(graphElementOpacity(research, "node", "card:b", DIMMED)).toBeCloseTo(HALF);
    expect(graphElementOpacity(research, "node", "card:c", DIMMED)).toBeCloseTo(HALF);
    expect(graphElementOpacity(research, "node", "card:a", DIMMED)).toBe(1);

    // Leaving half-way turns back from where b and c stand, not from where
    // the fade was heading.
    const leaving = beginDimTransition(research, null, 2_000, 100);
    expect(graphElementOpacity(leaving, "node", "card:b", DIMMED)).toBeCloseTo(HALF);
    expect(graphElementOpacity(leaving, "node", "card:c", DIMMED)).toBeCloseTo(HALF);
    leaving.progress = 0.5;
    expect(graphElementOpacity(leaving, "node", "card:b", DIMMED)).toBeCloseTo(THREE_QUARTERS);
    leaving.progress = 1;
    expect(graphElementOpacity(leaving, "node", "card:b", DIMMED)).toBe(1);
    expect(graphElementOpacity(leaving, "node", "card:c", DIMMED)).toBe(1);
  });

  it("starts a pointer crossing a pill and leaving from where its fade stood", () => {
    const entering = beginDimTransition(restingDimTransition(), graphHoverHighlight(DESIGN, LINKS), 0, 150);
    entering.progress = 0.4;
    const standing = graphElementOpacity(entering, "node", "card:c", DIMMED);
    const leaving = beginDimTransition(entering, null, 60, 100);
    // The fade it interrupted is frozen where it stood: advancing the old
    // object no longer moves the new start.
    entering.progress = 1;
    expect(graphElementOpacity(leaving, "node", "card:c", DIMMED)).toBeCloseTo(standing);
    expect(graphElementOpacity(leaving, "node", "card:a", DIMMED)).toBe(1);
  });

  it("advances on an eased clock and arrives at once without a duration", () => {
    const fade = beginDimTransition(restingDimTransition(), graphHoverHighlight(DESIGN, LINKS), 100, 150);
    expect(fade.progress).toBe(0);
    expect(dimProgressAt(fade, 100)).toBe(0);
    expect(dimProgressAt(fade, 175)).toBeGreaterThan(0.5);
    expect(dimProgressAt(fade, 175)).toBeLessThan(1);
    expect(dimProgressAt(fade, 250)).toBe(1);
    const instant = beginDimTransition(restingDimTransition(), graphHoverHighlight(DESIGN, LINKS), 100, 0);
    expect(instant.progress).toBe(1);
    expect(dimProgressAt(instant, 100)).toBe(1);
  });
});

describe("dimmed colours", () => {
  const DIMMED = GRAPH_CONTEXT_OPACITY;
  const half = String(Number((DIMMED / 2).toFixed(4)));

  it("writes a line colour at the dimmed opacity in the form it came in", () => {
    expect(colorAtOpacity("oklch(0.243 0 0)")(DIMMED)).toBe(`oklch(0.243 0 0 / ${DIMMED})`);
    expect(colorAtOpacity("rgb(238, 238, 238)")(DIMMED)).toBe(`rgba(238, 238, 238, ${DIMMED})`);
    expect(colorAtOpacity("rgba(238, 238, 238, 0.5)")(DIMMED)).toBe(`rgba(238, 238, 238, ${half})`);
    expect(colorAtOpacity("#eeeeee")(DIMMED)).toBe(`rgba(238, 238, 238, ${DIMMED})`);
    expect(colorAtOpacity("color(srgb 0.9 0.9 0.9 / 50%)")(0.5)).toBe("color(srgb 0.9 0.9 0.9 / 0.25)");
  });

  it("leaves a lit line and a colour it cannot read as they are", () => {
    expect(colorAtOpacity("oklch(0.243 0 0)")(1)).toBe("oklch(0.243 0 0)");
    expect(colorAtOpacity("var(--border)")(DIMMED)).toBe("var(--border)");
  });
});
