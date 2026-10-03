// Keyboard of the tab strip (SPEC_TABS.md, В49, В55, В57). Pure: keys in,
// decisions out.


/** What a key pressed on a focused tab asks for. */
export type TabKeyAction =
  | { kind: "focus"; index: number }
  | { kind: "activate" }
  | { kind: "close" }
  | null;

/** The roving-focus move or the action for `key` on tab `index` of `count`.
 *  Arrows go round the ends, as a tab list does. */
export function tabKeyAction(key: string, index: number, count: number): TabKeyAction {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowLeft":
      return { kind: "focus", index: (index - 1 + count) % count };
    case "ArrowRight":
      return { kind: "focus", index: (index + 1) % count };
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: count - 1 };
    case "Enter":
    case " ":
      return { kind: "activate" };
    case "Delete":
    case "Backspace":
      return { kind: "close" };
    default:
      return null;
  }
}

/** Whether `event` is one of the chords of command `id` that a page answers
 *  itself: its alternates. The binding (⇧⌘] and ⇧⌘[) is an item of the
 *  native menu, which takes its key in any page of the window (В57). */
/** The tab that takes focus when the focused one at `index` closes: the
 *  one to its right, else to its left (В53). */
export function focusAfterClose(index: number, count: number): number | null {
  if (count <= 1) return null;
  return index < count - 1 ? index + 1 : index - 1;
}
