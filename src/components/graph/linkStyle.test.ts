import { describe, expect, it } from "vitest";
import {
  GRAPH_RELATED_NOTE_CURVATURE,
  GRAPH_WIKILINK_CURVATURE,
  graphLinkCurvature,
  graphLinkLineDash,
} from "./linkStyle";

describe("graph link style", () => {
  it("keeps collection membership straight and solid", () => {
    const link = {
      kind: "collection_membership" as const,
      source: "collection:Design",
      target: "card:example",
    };

    expect(graphLinkCurvature(link)).toBe(0);
    expect(graphLinkLineDash(link, 1)).toBeNull();
  });

  it("uses curved dashed wikilinks with screen-fixed dash segments", () => {
    const link = {
      kind: "wikilink" as const,
      source: "card:source",
      target: "card:target",
    };

    expect(Math.abs(graphLinkCurvature(link))).toBe(GRAPH_WIKILINK_CURVATURE);
    expect(graphLinkLineDash(link, 1)).toEqual([4, 4]);
    expect(graphLinkLineDash(link, 2)).toEqual([2, 2]);
    expect(graphLinkLineDash(link, 0)).toEqual([4, 4]);
  });

  it("keeps pair curvature stable across direction and separates relation kinds", () => {
    const wikilink = {
      kind: "wikilink" as const,
      source: "card:alpha",
      target: "card:beta",
    };
    const reverse = {
      ...wikilink,
      source: wikilink.target,
      target: wikilink.source,
    };
    const related = {
      ...wikilink,
      kind: "related_note" as const,
    };

    expect(graphLinkCurvature(reverse)).toBe(graphLinkCurvature(wikilink));
    expect(Math.abs(graphLinkCurvature(related))).toBe(GRAPH_RELATED_NOTE_CURVATURE);
    expect(Math.sign(graphLinkCurvature(related))).toBe(Math.sign(graphLinkCurvature(wikilink)));
  });
});
