// Surface-search query normalization shared by the search overlay and any
// future search entry point: trim + collapse inner whitespace runs. The
// backend tokenizes by whitespace (SPEC_SEARCH.md → Query Semantics), so a
// normalized query is the canonical request/race-check identity.

export function normalizeSurfaceSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
