// Recent tags: tracks most recently used collection refs for channel menus.
// Stored in localStorage, max 10 entries, most recent first.

const STORAGE_KEY = "mine:recentTags";
const LEGACY_STORAGE_KEY = "arena:recentTags";
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
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) return JSON.parse(current);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return [];
    localStorage.setItem(STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return JSON.parse(legacy);
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
