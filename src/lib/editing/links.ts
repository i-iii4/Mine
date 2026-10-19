// Links in the editor (SPEC_EDITING.md, Л10.1, Л11.1): what a link at a place
// of the document leads to, read from the tree the way the reading mode reads
// the same source, so that a click means the same on both surfaces. A drawn
// link opens with a plain click, a revealed one takes the caret and opens
// with ⌘-click; the decision is `noteInteractionIntent`'s, the editor only
// carries it out through its host.

import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { Facet, type EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { noteInteractionIntent, type NoteInteractionIntent, type NoteLinkTarget } from "@/lib/reading/intents";
import { isRevealed, revealField } from "./reveal";
import { NODE } from "./syntax";

/** The prefix the reading mode's sanitizer puts on every `id`, which its
 *  footnote links carry (Ч10). */
const USER_CONTENT_PREFIX = "user-content-";

/** A link of the document and where it leads. */
export interface EditorLink {
  from: number;
  to: number;
  target: NoteLinkTarget;
}

/** What the editor's host does for a link (Л10.1). */
export interface EditorLinkHost {
  /** A wikilink's target, as written (`Note`, `Folder/Note#Heading`): the
   *  host writes the session's edits, resolves it and opens the note. */
  openNote(target: string): void;
  /** An address outside the note: the browser. */
  openExternal(href: string): void;
}

export const editorLinkHost = Facet.define<EditorLinkHost, EditorLinkHost | null>({
  combine: (values) => values[0] ?? null,
});

/** The id the reading mode gives a footnote's definition (`fn-…`) or its
 *  first reference (`fnref-…`), by GFM's rule: the label in lower case. */
export function footnoteFragment(kind: "fn" | "fnref", label: string): string {
  return `${USER_CONTENT_PREFIX}${kind}-${encodeURIComponent(label.toLowerCase())}`;
}

/** Where a Markdown destination leads, as the reading mode's link reads its
 *  `href`: `#…` stays in the note, anything else leaves it. */
function destinationTarget(destination: string): NoteLinkTarget {
  if (destination.startsWith("#")) return { kind: "anchor", fragment: destination.slice(1) };
  return { kind: "external", href: destination };
}

function linkOf(state: EditorState, node: SyntaxNode): EditorLink | null {
  const doc = state.doc;
  switch (node.name) {
    case NODE.Wikilink: {
      const target = node.getChild(NODE.WikilinkTarget);
      if (!target) return null;
      return { from: node.from, to: node.to, target: { kind: "note", target: doc.sliceString(target.from, target.to) } };
    }
    case "Link": {
      const url = node.getChild("URL");
      if (!url) return null;
      const raw = doc.sliceString(url.from, url.to);
      // `<…>` keeps a destination with spaces.
      const destination = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
      return { from: node.from, to: node.to, target: destinationTarget(destination) };
    }
    case "Autolink": {
      const url = node.getChild("URL");
      if (!url) return null;
      return { from: node.from, to: node.to, target: { kind: "external", href: doc.sliceString(url.from, url.to) } };
    }
    case "URL":
      // Only an address among words is a link of its own; inside a link or a
      // picture it is that one's destination.
      if (node.parent?.name === "Link" || node.parent?.name === "Image" || node.parent?.name === "Autolink") return null;
      return { from: node.from, to: node.to, target: { kind: "external", href: doc.sliceString(node.from, node.to) } };
    case NODE.FootnoteReference: {
      const label = doc.sliceString(node.from + 2, node.to - 1);
      return { from: node.from, to: node.to, target: { kind: "anchor", fragment: footnoteFragment("fn", label) } };
    }
    default:
      return null;
  }
}

/** The link that covers position `pos` of the document, the innermost one
 *  first; `null` when there is none. */
export function linkAt(state: EditorState, pos: number): EditorLink | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const link = linkOf(state, node);
      if (link) return link;
    }
  }
  return null;
}

/** Whether the link shows its source now (Л5.2). */
export function isLinkRevealed(state: EditorState, link: EditorLink): boolean {
  return isRevealed(state.field(revealField), link.from, link.to);
}

/** The place of the document a fragment of the note names (Ч10): a
 *  footnote's definition or its first reference; `null` for any other. */
export function anchorPosition(state: EditorState, fragment: string): number | null {
  let id: string;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    id = fragment;
  }
  if (id.startsWith(USER_CONTENT_PREFIX)) id = id.slice(USER_CONTENT_PREFIX.length);
  const match = /^(fn|fnref)-(.+)$/.exec(id);
  if (!match) return null;
  const [, kind, label] = match;
  const wanted = (label ?? "").toLowerCase();
  const doc = state.doc;
  let found: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (found !== null) return false;
      if (kind === "fn" && node.name === NODE.FootnoteDefinition) {
        const mark = node.node.getChild(NODE.FootnoteDefinitionMark);
        if (mark && doc.sliceString(mark.from + 2, mark.to - 2).toLowerCase() === wanted) found = node.from;
        return false;
      }
      if (kind === "fnref" && node.name === NODE.FootnoteReference) {
        if (doc.sliceString(node.from + 2, node.to - 1).toLowerCase() === wanted) found = node.from;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/** The editor carries out what an event on a link means (Л10.1, Л11.1). The
 *  intents it has no part in say why. Whether it handled the event. */
export function carryOutLinkIntent(view: EditorView, intent: NoteInteractionIntent): boolean {
  const host = view.state.facet(editorLinkHost);
  switch (intent.kind) {
    case "OpenNote":
      host?.openNote(intent.target);
      return true;
    case "OpenExternal":
      host?.openExternal(intent.href);
      return true;
    case "JumpToAnchor": {
      // A place of the note: shown in the middle, the caret stays where it
      // is, as the reading mode scrolls without selecting.
      const pos = anchorPosition(view.state, intent.fragment);
      if (pos !== null) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      return true;
    }
    // A revealed link is text: CodeMirror places the caret. No other
    // intent comes of a link.
    case "PlaceCaret":
    case "ToggleTask":
    case "OpenImagePreview":
    case "OpenEmbed":
    case "EnterTableCell":
    case "SelectBlock":
    case "RevealBlock":
    case "Nothing":
      return false;
    default: {
      const unhandled: never = intent;
      return unhandled;
    }
  }
}

/** The link a pointer event hit: the drawn `a` of a link or a footnote's
 *  number, inside the editor's text. */
function linkOfEvent(view: EditorView, event: MouseEvent): EditorLink | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const element = target.closest("a, .cm-md-footnote");
  if (!element || !view.contentDOM.contains(element)) return null;
  // A link inside a widget acts as the reading mode's own element does.
  if (element.closest(".cm-md-block, .cm-md-inline-media")) return null;
  return linkAt(view.state, view.posAtDOM(element, 0));
}

/** Whether an event asks to open what it hits (⌘-click on macOS). */
function isCommandClick(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** The intent of a pointer event on a link. */
export function linkEventIntent(view: EditorView, event: MouseEvent): { link: EditorLink; intent: NoteInteractionIntent } | null {
  if (event.button !== 0) return null;
  const link = linkOfEvent(view, event);
  if (!link) return null;
  const intent = noteInteractionIntent({
    surface: "editing",
    element: { kind: "link", to: link.target },
    event: isCommandClick(event) ? "command-click" : "click",
    revealed: isLinkRevealed(view.state, link),
  });
  return { link, intent };
}

/**
 * Clicks on links (Л10.1): a press that will open a link keeps the caret
 * where it is, so the link is not revealed under the pointer, and the click
 * opens it; a press on a revealed link is CodeMirror's.
 */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const hit = linkEventIntent(view, event);
    if (!hit || hit.intent.kind === "PlaceCaret" || hit.intent.kind === "Nothing") return false;
    event.preventDefault();
    return true;
  },
  click(event, view) {
    const hit = linkEventIntent(view, event);
    if (!hit) return false;
    if (!carryOutLinkIntent(view, hit.intent)) return false;
    event.preventDefault();
    return true;
  },
});
