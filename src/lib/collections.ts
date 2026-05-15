/** Return the visible label for a Markdown-first collection ref. */
export function collectionRefLabel(ref: string): string {
  const parts = ref.split("/");
  return (parts[parts.length - 1] ?? ref).trim();
}
