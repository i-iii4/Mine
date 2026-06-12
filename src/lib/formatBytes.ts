// Decimal base (1 KB = 1000 B) — the macOS Finder convention, so sizes shown
// in Mine match what the user sees in Finder for the same files
// (SPEC_SETTINGS_WINDOW.md, решение Р-7).
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
