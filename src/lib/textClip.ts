// Whether a one-line text cell clips its text. A cell's edge dissolve belongs
// to a text that does not fit: a text that ends inside the cell stays whole,
// with no fade at its end (user's decision of 22.10.2026). The cell carries
// `data-text-clipped` while its text reaches past the clear tail the dissolve
// keeps before the cell's end; the stylesheet applies the mask only then.

/** The attribute a cell carries while its text does not fit. */
export const TEXT_CLIPPED_ATTRIBUTE = "data-text-clipped";

/** Whether the text box `[left, right]` reaches past the cell's `[start, end]`
 *  less the clear `tail` at its end. */
export function textOverflows(
  text: { left: number; right: number },
  cell: { left: number; right: number },
  tail: number,
): boolean {
  // Half a pixel of slack: subpixel text widths round both ways.
  return text.left < cell.left - 0.5 || text.right > cell.right - tail + 0.5;
}

function measure(cell: HTMLElement, tail: number): void {
  const range = document.createRange();
  range.selectNodeContents(cell);
  const text = range.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const clipped = text.width > 0 && textOverflows(text, box, tail);
  if (clipped) cell.setAttribute(TEXT_CLIPPED_ATTRIBUTE, "");
  else cell.removeAttribute(TEXT_CLIPPED_ATTRIBUTE);
}

const tails = new WeakMap<Element, number>();
let resizeObserver: ResizeObserver | null = null;

function sharedResizeObserver(): ResizeObserver {
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const tail = tails.get(entry.target);
      if (tail !== undefined) measure(entry.target as HTMLElement, tail);
    }
  });
  return resizeObserver;
}

/** Keep `cell`'s `data-text-clipped` current: on its own resize, on a change
 *  of its text, and once the fonts settle. Returns the teardown. */
export function observeTextClip(cell: HTMLElement, tail: number): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  tails.set(cell, tail);
  const resize = sharedResizeObserver();
  resize.observe(cell);
  const mutation = new MutationObserver(() => measure(cell, tail));
  mutation.observe(cell, { subtree: true, childList: true, characterData: true });
  let live = true;
  void document.fonts?.ready.then(() => {
    if (live) measure(cell, tail);
  });
  return () => {
    live = false;
    resize.unobserve(cell);
    mutation.disconnect();
    tails.delete(cell);
  };
}
