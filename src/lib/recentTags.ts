// Recent tags: tracks most recently used collection refs for channel menus.
// Stored in localStorage, max 10 entries, most recent first.

const STORAGE_KEY = "arena:recentTags";
const MAX_RECENT = 10;

function normalizeCollectionRef(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped = trimmed.startsWith("[[") && trimmed.endsWith("]]")
    ? trimmed.slice(2, -2)
    : trimmed;
  return unwrapped.split("|")[0]?.trim() ?? "";
}

export function getRecentTags(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushRecentTag(tag: string): void {
  const collectionRef = normalizeCollectionRef(tag);
  if (!collectionRef) return;
  const recent = getRecentTags().filter((t) => t !== collectionRef);
  recent.unshift(collectionRef);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(recent.slice(0, MAX_RECENT)),
  );
}
