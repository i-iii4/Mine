export function selectedCardCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} карточка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} карточки`;
  }
  return `${count} карточек`;
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
