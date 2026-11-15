// The pointer left the page: out of the window, on to another screen, over
// another page of the window (SPEC_MOTION_LEVELS.md, «Подсказка уходит, когда
// курсор покинул окно»). WebKit tells a page so with `pointerout` and
// `pointerleave` from the element under the pointer up to the root, with no
// related target, and sends no `pointermove` (Mine passes every exit of a
// page on to it, SPEC_TABS.md, В85). CSS `:hover` and the page's leave
// handlers hear it; what waits for the next move to learn the pointer has
// gone does not, and stays: a Radix tooltip after its button.
//
// One listener per document, on its root: the root is left only when the
// pointer leaves the page, never when it goes from one element to another,
// and an embedded frame lies inside the root.

type Listener = () => void;

const listeners = new WeakMap<Document, Set<Listener>>();

function rootLeft(event: PointerEvent): void {
  if (event.relatedTarget !== null) return;
  const document = event.currentTarget instanceof Element ? event.currentTarget.ownerDocument : null;
  const set = document ? listeners.get(document) : undefined;
  if (!set) return;
  for (const listener of [...set]) listener();
}

/** Calls `listener` each time the pointer leaves `document`'s page. Returns
 *  the end of the call; the last one removes the document's listener. */
export function onPointerLeftPage(listener: Listener, document: Document = globalThis.document): () => void {
  let set = listeners.get(document);
  if (!set) {
    set = new Set();
    listeners.set(document, set);
    document.documentElement.addEventListener("pointerleave", rootLeft);
  }
  set.add(listener);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const current = listeners.get(document);
    if (!current) return;
    current.delete(listener);
    if (current.size > 0) return;
    listeners.delete(document);
    document.documentElement.removeEventListener("pointerleave", rootLeft);
  };
}
