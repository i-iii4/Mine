function escapeCssAttributeValue(value: string): string {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }
  return value.replace(/["\\\n\r\f]/g, (char) => `\\${char}`);
}

export function blockSlugSelector(slug: string): string {
  return `[data-block-slug="${escapeCssAttributeValue(slug)}"]`;
}

export function findBlockElement(slug: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(blockSlugSelector(slug));
}
