// Pure mapping from a search-result LightBlock to the overlay list row.
//
// Encodes the Match Metadata rendering rules (SPEC_SEARCH.md) for the list
// surface, mirroring what feed cards do:
// - title match    → highlight ranges on the title line, snippet stays the
//   normal preview text without a mark;
// - description/body match → snippet is the backend excerpt with mark ranges;
// - semantic match → snippet is the excerpt, no ranges, no fake highlight;
// - author/url match → ranking-only metadata: snippet is the normal preview
//   text, the matched metadata never leaks into the rendered row;
// - media block without any text → no snippet, the row stays single-line.

import type { LightBlock, SearchMatch } from "@/types";
import { getDisplayTitle, getFallbackLabel } from "@/lib/displayTitle";

export interface SearchResultRow {
  title: string;
  titleMatch: SearchMatch | null;
  snippet: string | null;
  snippetMatch: SearchMatch | null;
}

const SNIPPET_MATCH_FIELDS: ReadonlySet<SearchMatch["field"]> = new Set([
  "description",
  "body",
  "semantic",
]);

export function deriveSearchResultRow(block: LightBlock): SearchResultRow {
  const title = getDisplayTitle(block) ?? getFallbackLabel(block);
  const match = block.search_match ?? null;

  const titleMatch = match?.field === "title" ? match : null;

  const excerptMatch =
    match && SNIPPET_MATCH_FIELDS.has(match.field) && match.excerpt.trim().length > 0
      ? match
      : null;
  const fallbackPreview = block.preview_text?.trim() ?? "";
  const snippet = excerptMatch ? match!.excerpt : fallbackPreview;

  return {
    title,
    titleMatch,
    snippet: snippet.length > 0 ? snippet : null,
    snippetMatch: excerptMatch,
  };
}
