const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].join(",");

/// The elements Tab visits inside `container`, in document order.
export function tabbableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) => (
    element.tabIndex >= 0
    && !element.closest("[hidden], [inert], fieldset[disabled]")
  ));
}

/// Keeps Tab inside the clipper panel (SPEC_CLIPPER.md, keyboard): past the
/// last element it returns to the first, and Shift+Tab from the first goes to
/// the last, so the keyboard never falls into the page behind the panel.
/// Returns the element to focus, or `null` when the browser's own step stays
/// inside the panel.
export function wrapTabFocus(
  container: HTMLElement,
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  const items = tabbableIn(container);
  if (items.length === 0) return null;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const outside = !active || active === container || !items.includes(active as HTMLElement);
  if (backwards) return active === first || outside ? last : null;
  return active === last || outside ? first : null;
}
