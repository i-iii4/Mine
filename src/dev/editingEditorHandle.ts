// The note's editor as the browser checks of the editing page drive it
// (SPEC_EDITING.md, Л14, Л17): its document, its selection, how far its text
// is parsed. Like the table handle it loads the editor's modules when a check
// first asks, so the page imports nothing of CodeMirror itself (Л0.6). Dev
// only.

/** The note's editor, found by its root: `.cm-content` inside an open cell
 *  would be the cell editor's. */
async function mainView() {
  const [{ EditorView }, { syntaxTree }, { undo }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/language"),
    import("@codemirror/commands"),
  ]);
  const root = document.querySelector<HTMLElement>(".mine-note-editor");
  return { view: root ? EditorView.findFromDOM(root) : null, syntaxTree, undo };
}

/** What the browser checks read and drive of the note's editor. */
export interface EditingEditorHandle {
  /** The document, its lines joined by the note's own line break. */
  text(): Promise<string | null>;
  /** The position of the document right after the first `text`, its lines
   *  joined by `\n` as positions count them; `null` without it. */
  after(text: string): Promise<number | null>;
  /** The main selection. */
  selection(): Promise<{ anchor: number; head: number } | null>;
  /** The caret, or a selection, at a place of the document, with the
   *  focus, as a press there puts it. */
  select(anchor: number, head?: number): Promise<boolean>;
  /** How far the text is parsed, and its length. */
  parsed(): Promise<{ to: number; length: number } | null>;
  /** Undo in the editor's history, as the Edit menu's Undo will (row 50.24
   *  waits for its decisions). */
  undo(): Promise<boolean>;
}

/** The handle of `window.__editing.editor`. */
export function editingEditorHandle(): EditingEditorHandle {
  return {
    async text() {
      const { view } = await mainView();
      return view ? view.state.sliceDoc() : null;
    },
    async after(text) {
      const { view } = await mainView();
      const index = view ? view.state.doc.toString().indexOf(text) : -1;
      return index < 0 ? null : index + text.length;
    },
    async selection() {
      const { view } = await mainView();
      if (!view) return null;
      const { anchor, head } = view.state.selection.main;
      return { anchor, head };
    },
    async select(anchor, head = anchor) {
      const { view } = await mainView();
      if (!view) return false;
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true, userEvent: "select" });
      view.focus();
      return true;
    },
    async parsed() {
      const { view, syntaxTree } = await mainView();
      return view ? { to: syntaxTree(view.state).length, length: view.state.doc.length } : null;
    },
    async undo() {
      const { view, undo } = await mainView();
      return view ? undo(view) : false;
    },
  };
}
