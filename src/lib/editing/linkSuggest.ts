// The `[[` menu (SPEC_EDITING.md, Л10.2; Local MD, SPEC_WIKILINK_AUTOCOMPLETE):
// while the caret stands in an open `[[…` of its line, outside code and
// formulas, the backend suggests notes, a note's headings after `#` or its
// blocks after `^`; `|` ends the suggestion and leaves the alias to the
// person. The context is read from the line, not from a word, so the menu
// lives on through spaces. The backend ranks and highlights; the menu keeps
// its order. A choice replaces the whole construct from `[[` to `]]`, the
// `]]` that closing brackets put there included, so it is never doubled; an
// alias after `|` stays. No embed `![[` is suggested, and nothing is asked
// during a composition (Л13.1).

import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState, Facet, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { NODE } from "./syntax";

/** What the menu asks the backend (`NoteLinkQuery`). */
export type LinkQuery =
  | { kind: "notes"; text: string }
  | { kind: "headings"; note: string; text: string }
  | { kind: "blocks"; note: string; text: string };

/** One suggestion of the backend (`NoteLinkSuggestion`). */
export interface LinkSuggestion {
  label: string;
  detail: string;
  /** What goes between `[[` and `]]`. */
  target: string;
  slug: string;
  /** The matched parts of `label`, in its string offsets. */
  matches: ReadonlyArray<{ start: number; end: number }>;
}

/** Where the menu gets its suggestions: the backend, through the host. */
export interface LinkSuggestHost {
  suggest(query: LinkQuery): Promise<readonly LinkSuggestion[]>;
}

export const linkSuggestHost = Facet.define<LinkSuggestHost, LinkSuggestHost | null>({
  combine: (values) => values[0] ?? null,
});

/** The open `[[…` the caret stands in. */
export interface WikilinkContext {
  /** Where `[[` starts. */
  open: number;
  /** Where the construct the choice replaces ends: after the `]]` that
   *  follows the caret on its line, at the `|` of an alias, or the caret. */
  end: number;
  /** Whether an alias follows the caret: the choice keeps `|…]]`. */
  keepsAlias: boolean;
  /** Where the text the query is made of starts. */
  queryFrom: number;
  query: LinkQuery;
}

/** The nodes inside which `[[` is no link: code and formulas (Л10.2). */
const NO_LINK_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  NODE.InlineMath,
  NODE.MathBlock,
  "HTMLBlock",
  "CommentBlock",
  "Comment",
]);

function insideNoLinkNode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (NO_LINK_NODES.has(node.name)) return true;
  }
  return false;
}

/** The open `[[…` at `pos`, or `null` where the menu has no place. */
export function wikilinkContext(state: EditorState, pos: number): WikilinkContext | null {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const openIndex = before.lastIndexOf("[[");
  if (openIndex < 0) return null;
  // `![[` is an embed; `\[[` is no link.
  const previous = before[openIndex - 1];
  if (previous === "!" || previous === "\\") return null;
  const typed = before.slice(openIndex + 2);
  if (typed.includes("]]") || typed.includes("|")) return null;
  const open = line.from + openIndex;
  if (insideNoLinkNode(state, pos) || insideNoLinkNode(state, open + 1)) return null;

  const after = line.text.slice(pos - line.from);
  const close = after.indexOf("]]");
  const nextOpen = after.indexOf("[[");
  const bar = after.indexOf("|");
  let end = pos;
  let keepsAlias = false;
  if (close >= 0 && (nextOpen < 0 || close < nextOpen)) {
    if (bar >= 0 && bar < close) {
      end = pos + bar;
      keepsAlias = true;
    } else {
      end = pos + close + 2;
    }
  }

  const hash = typed.indexOf("#");
  const typedFrom = open + 2;
  if (hash < 0) return { open, end, keepsAlias, queryFrom: typedFrom, query: { kind: "notes", text: typed } };
  const note = typed.slice(0, hash).trim();
  // `[[#…` names the note itself, which the menu does not offer.
  if (!note) return null;
  const rest = typed.slice(hash + 1);
  if (rest.startsWith("^")) {
    return { open, end, keepsAlias, queryFrom: typedFrom + hash + 2, query: { kind: "blocks", note, text: rest.slice(1) } };
  }
  const lastHash = rest.lastIndexOf("#");
  const text = rest.slice(lastHash + 1);
  return { open, end, keepsAlias, queryFrom: typedFrom + hash + 1 + lastHash + 1, query: { kind: "headings", note, text } };
}

/** The change a choice makes (Л10.2): the construct from `[[` becomes
 *  `[[target]]`, or `[[target` before a kept alias, and the caret goes after
 *  it. */
export function wikilinkInsertion(context: WikilinkContext, target: string) {
  const insert = context.keepsAlias ? `[[${target}` : `[[${target}]]`;
  return {
    changes: { from: context.open, to: context.end, insert },
    selection: { anchor: context.open + insert.length },
    userEvent: "input.complete",
  };
}

/** A suggestion of the menu, with what the backend said of it. */
interface LinkCompletion extends Completion {
  suggestion: LinkSuggestion;
}

function isLinkCompletion(completion: Completion): completion is LinkCompletion {
  return "suggestion" in completion;
}

/** The menu's source of suggestions. */
export async function wikilinkCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  if (context.view?.composing) return null;
  const host = context.state.facet(linkSuggestHost);
  if (!host) return null;
  const found = wikilinkContext(context.state, context.pos);
  if (!found) return null;
  const suggestions = await host.suggest(found.query);
  if (context.aborted) return null;
  const options: LinkCompletion[] = suggestions.map((suggestion) => ({
    label: suggestion.label,
    detail: suggestion.detail || undefined,
    suggestion,
    apply: (view: EditorView) => {
      // The construct as it stands now: the menu may answer after a
      // keystroke the query did not see.
      const current = wikilinkContext(view.state, view.state.selection.main.head) ?? found;
      view.dispatch(wikilinkInsertion(current, suggestion.target));
    },
  }));
  return {
    from: found.queryFrom,
    to: context.pos,
    options,
    filter: false,
    getMatch: (completion) => (isLinkCompletion(completion)
      ? completion.suggestion.matches.flatMap((match) => [match.start, match.end])
      : []),
  };
}

/** The class of the menu: `editor.css` draws it as a floating menu of Mine. */
export const LINK_MENU_CLASS = "mine-link-menu";
/** A row of the menu without a second line. */
const SINGLE_LINE_OPTION_CLASS = "mine-link-option-single";
/** The rows the menu shows before it scrolls: whole rows only
 *  (DESIGN_SYSTEM.md, «Высота Scrollable Menu»). */
export const LINK_MENU_VISIBLE_ROWS = 8;

/** The menu takes the width of a list a search makes (DESIGN_SYSTEM.md,
 *  «Ширина», role `search`): the role's attribute on its element. */
const menuWidthRole = ViewPlugin.fromClass(class {
  update(update: ViewUpdate) {
    const menu = update.view.dom.querySelector(`.${LINK_MENU_CLASS}`);
    if (menu && menu.getAttribute("data-floating-menu") !== "search") menu.setAttribute("data-floating-menu", "search");
  }
});

/** The `[[` menu and closing brackets for `[`, `(` and `{` only: quotes are
 *  the text's apostrophes (Л10.2). */
export function linkSuggestions(): Extension {
  return [
    autocompletion({
      override: [wikilinkCompletions],
      activateOnTyping: true,
      icons: false,
      closeOnBlur: true,
      // The floating layers' shadow (DESIGN_SYSTEM.md, «Контейнер»).
      tooltipClass: () => `${LINK_MENU_CLASS} shadow-md`,
      optionClass: (completion) => (completion.detail ? "" : SINGLE_LINE_OPTION_CLASS),
    }),
    // Tab takes a suggestion as Enter does; with no menu it is the list's.
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{"] } }]),
    menuWidthRole,
  ];
}
