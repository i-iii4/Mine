const pad = (value: number) => String(value).padStart(2, "0");

/** `saved_at` of a new card: the local wall clock, `YYYY-MM-DDTHH:MM:SS`,
 *  without a time zone. Obsidian reads this form as a date; a `Z` suffix makes
 *  it plain text (decision of the user, 27.09.2026). The browser executor's
 *  fallback in lib/standaloneVault.js writes the same form. */
export function localSavedAt(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
