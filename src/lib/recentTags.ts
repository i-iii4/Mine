// Recent tags: tracks most recently used tags for channel menus.
// Stored in localStorage, max 10 entries, most recent first.

const STORAGE_KEY = "arena:recentTags";
const MAX_RECENT = 10;

/** Mirror Rust normalize_tag: trim, lowercase, spaces/underscores to hyphens. */
function normalizeTag(raw: string): string {
  const lower = raw.trim().toLowerCase();
  let result = "";
  let prevDash = false;
  for (const c of lower) {
    if (/\p{L}|\p{N}/u.test(c)) {
      result += c;
      prevDash = false;
    } else if (c === "-" || c === " " || c === "_") {
      if (!prevDash && result.length > 0) {
        result += "-";
        prevDash = true;
      }
    }
  }
  if (result.endsWith("-")) {
    result = result.slice(0, -1);
  }
  return result;
}

export function getRecentTags(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushRecentTag(tag: string): void {
  const normalized = normalizeTag(tag);
  if (!normalized) return;
  const recent = getRecentTags().filter((t) => t !== normalized);
  recent.unshift(normalized);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(recent.slice(0, MAX_RECENT)),
  );
}
