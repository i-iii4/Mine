// Shared search-highlight rendering for feed cards and the search overlay.
//
// The backend returns plain excerpt text plus char ranges (SPEC_SEARCH.md →
// Match Metadata). Rendering draws the design-system search marker — a real
// text highlighter (`bg-search-mark` yellow with fixed dark ink) — over those
// ranges and never invents highlights: a match whose excerpt does not equal
// the rendered text, or with no ranges (semantic / author / url evidence),
// renders as plain text.

import type { ReactNode } from "react";
import type { LightBlock } from "@/types";

export function renderSearchHighlightedText(
  text: string,
  match: LightBlock["search_match"] | null | undefined,
): ReactNode {
  if (!match || match.ranges.length === 0 || match.excerpt !== text) {
    return text;
  }

  const chars = Array.from(text);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  match.ranges
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= chars.length)
    .sort((a, b) => a.start - b.start)
    .forEach((range, index) => {
      if (range.start < cursor) return;
      if (range.start > cursor) {
        nodes.push(chars.slice(cursor, range.start).join(""));
      }
      nodes.push(
        <mark
          key={`search-match-${index}`}
          className="bg-search-mark p-0 text-search-mark-foreground"
        >
          {chars.slice(range.start, range.end).join("")}
        </mark>,
      );
      cursor = range.end;
    });
  if (cursor < chars.length) {
    nodes.push(chars.slice(cursor).join(""));
  }

  return nodes.length > 0 ? nodes : text;
}

export function searchExcerptText(
  match: LightBlock["search_match"] | null | undefined,
  fallback: string,
): string {
  const excerpt = match?.excerpt;
  return excerpt && excerpt.trim().length > 0 ? excerpt : fallback;
}
