// Recent tags: tracks most recently used tags for channel menus.
// Stored in localStorage, max 10 entries, most recent first.

const STORAGE_KEY = "arena:recentTags";
const MAX_RECENT = 10;

export function getRecentTags(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushRecentTag(tag: string): void {
  const recent = getRecentTags().filter((t) => t !== tag);
  recent.unshift(tag);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(recent.slice(0, MAX_RECENT)),
  );
}
