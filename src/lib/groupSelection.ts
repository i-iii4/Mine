export function selectedElementCountLabel(count: number): string {
  return `${count} ${count === 1 ? "element" : "elements"}`;
}

export function patchTagLookup(
  lookup: ReadonlyMap<string, readonly string[]>,
  slugs: readonly string[],
  tag: string,
  connected: boolean,
): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const [slug, tags] of lookup) {
    next.set(slug, [...tags]);
  }
  for (const slug of slugs) {
    const current = new Set(next.get(slug) ?? []);
    if (connected) {
      current.add(tag);
    } else {
      current.delete(tag);
    }
    next.set(slug, [...current]);
  }
  return next;
}

export function scheduleAfterOptimisticUiUpdate(task: () => void): void {
  if (typeof window === "undefined") {
    task();
    return;
  }

  window.setTimeout(task, 0);
}
