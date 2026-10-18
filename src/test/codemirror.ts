// What CodeMirror's view asks of a document that jsdom lacks: rectangles of
// ranges and text. jsdom lays nothing out, so every rectangle is empty; the
// view then draws its whole small test document and measures nothing, which
// is all the editor's jsdom tests need. Layout itself is the browser check's
// (SPEC_EDITING.md, Л17).

const EMPTY_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

/** Give jsdom's ranges and elements the empty rectangles CodeMirror reads. */
export function installCodeMirrorLayoutStubs(): void {
  const rangePrototype = Range.prototype as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (!rangePrototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => {
        const list: DOMRect[] = [];
        return Object.assign(list, { item: () => null });
      },
    });
  }
  if (!rangePrototype.getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => EMPTY_RECT,
    });
  }
}
