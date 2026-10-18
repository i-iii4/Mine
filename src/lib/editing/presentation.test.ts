import { ensureSyntaxTree, LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { editorBody, lineEndingExtensions } from "./lineEndings";
import {
  footnoteNumbers,
  HEADING_1_CLASSES,
  HEADING_CLASSES,
  LIST_ITEM_LINE_CLASS,
  LIST_SOURCE_CLASS,
  MISSING_LINK_CLASS,
  presentationItems,
  SOURCE_BLOCK_CLASS,
  TASK_DONE_CLASS,
  type PresentationItem,
} from "./presentation";
import type { RevealState } from "./reveal";
import { mineMarkdownLanguage } from "./syntax";

interface Options {
  /** Whether the person acted: by default, when the text shows a caret. */
  interacted?: boolean;
  revealedBlocks?: number[];
  missing?: string[];
  omittedEmbed?: number | null;
}

/** The caret's place in a text of these tests. */
const CARET = "‸";

/** The presentation of `text`, the caret where `‸` stands, as short lines,
 *  sorted:
 *  `conceal "**"`, `mark strong "**b**"`, `line <classes> @<line>`. */
function present(text: string, options: Options = {}): string[] {
  const caret = text.indexOf(CARET);
  const source = caret < 0 ? text : text.slice(0, caret) + text.slice(caret + CARET.length);
  const loaded = editorBody(source);
  const state = EditorState.create({
    doc: loaded.text,
    selection: EditorSelection.cursor(caret < 0 ? 0 : caret),
    extensions: [lineEndingExtensions(loaded.mode), new LanguageSupport(mineMarkdownLanguage)],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  if (!tree) throw new Error("no tree");
  const reveal: RevealState = {
    interacted: options.interacted ?? caret >= 0,
    selection: state.selection,
    blocks: options.revealedBlocks ?? [],
    waits: new Set(),
  };
  const numbers = footnoteNumbers(tree, state.doc);
  const items = presentationItems({
    state,
    tree,
    reveal,
    from: 0,
    to: state.doc.length,
    linkMissing: (note) => (options.missing ?? []).includes(note),
    footnoteNumber: (label) => numbers.get(label.toLowerCase()) ?? null,
    omittedEmbed: options.omittedEmbed ?? null,
  });
  return items.map((item) => summarize(item, state)).sort();
}

/** `items` sorted as `present` sorts its own. */
function sorted(items: string[]): string[] {
  return [...items].sort();
}

function summarize(item: PresentationItem, state: EditorState): string {
  const text = (from: number, to: number) => JSON.stringify(state.sliceDoc(from, to));
  switch (item.type) {
    case "conceal":
    case "mute":
      return `${item.type} ${text(item.from, item.to)}`;
    case "mark":
      return `mark ${item.tagName}${item.className ? `.${item.className}` : ""}${item.attributes?.title ? `[title=${item.attributes.title}]` : ""} ${text(item.from, item.to)}`;
    case "line":
      return `line ${item.className}${item.attributes?.["data-task-checked"] ? ` checked=${item.attributes["data-task-checked"]}` : ""} @${state.doc.lineAt(item.from).number}`;
    case "widget":
      return `widget ${JSON.stringify(item.widget)} ${text(item.from, item.to)}`;
    case "wrapper":
      return `wrapper ${item.tagName}${item.attributes?.class ? `.${item.attributes.class}` : ""}${item.attributes?.start ? `[start=${item.attributes.start}]` : ""} @${state.doc.lineAt(item.from).number}`;
  }
}

describe("headings (SPEC_EDITING.md, Л6)", () => {
  it("hides `#` in the rest and takes the article's heading font", () => {
    expect(present("# Title\n\n## Second")).toEqual(sorted([
      'conceal "# "',
      'conceal "## "',
      `line ${HEADING_1_CLASSES} @1`,
      `line ${HEADING_CLASSES} @3`,
    ]));
  });

  it("mutes `#` while the caret stands in the line", () => {
    expect(present("# Ti‸tle")).toEqual(sorted(['mute "# "', `line ${HEADING_1_CLASSES} @1`]));
  });
});

describe("emphasis, code, highlight (Л6)", () => {
  it("hides the marks in the rest, the text keeps its look", () => {
    expect(present("**bold** *it* ~~del~~ `code` ==mark==")).toEqual(sorted([
      'conceal "*"',
      'conceal "*"',
      'conceal "**"',
      'conceal "**"',
      'conceal "=="',
      'conceal "=="',
      'conceal "`"',
      'conceal "`"',
      'conceal "~~"',
      'conceal "~~"',
      'mark code "`code`"',
      'mark del "~~del~~"',
      'mark em "*it*"',
      'mark mark "==mark=="',
      'mark strong "**bold**"',
    ]));
  });

  it("reveals only the element under the caret, not its line (Л5.2)", () => {
    const items = present("**bo‸ld** and *it*");
    expect(items).toContain('mute "**"');
    expect(items.filter((item) => item === 'conceal "*"')).toHaveLength(2);
    expect(items.filter((item) => item === 'mute "**"')).toHaveLength(2);
  });

  it("reveals nothing for the caret the editor opens with (Л5.2)", () => {
    expect(present("‸**bold**", { interacted: false })).toContain('conceal "**"');
    expect(present("‸**bold**", { interacted: false })).not.toContain('mute "**"');
  });
});

describe("links (Л6)", () => {
  it("shows a link's label and hides the rest", () => {
    expect(present("see [label](https://example.com) now")).toEqual(sorted([
      'conceal "["',
      'conceal "](https://example.com)"',
      'mark a "label"',
    ]));
    expect(present("see [la‸bel](https://example.com)")).toEqual(sorted([
      'mark a "label"',
      'mute "["',
      'mute "](https://example.com)"',
    ]));
  });

  it("shows a wikilink's label or target, a missing note dim", () => {
    expect(present("[[Note|label]] and [[Other]]", { missing: ["Other"] })).toEqual(sorted([
      'conceal "Note|"',
      'conceal "[["',
      'conceal "[["',
      'conceal "]]"',
      'conceal "]]"',
      'mark a "label"',
      `mark a.${MISSING_LINK_CLASS} "Other"`,
    ]));
    expect(present("[[Note#He‸ading|label]]")).toEqual(sorted([
      'mark a "label"',
      'mute "Note#Heading"',
      'mute "[["',
      'mute "]]"',
      'mute "|"',
    ]));
  });

  it("draws literal and angle-bracket addresses as links", () => {
    expect(present("go https://example.com/a and <https://example.com/b>")).toEqual(sorted([
      'conceal "<"',
      'conceal ">"',
      'mark a "https://example.com/a"',
      'mark a "https://example.com/b"',
    ]));
  });
});

describe("HTML, escapes, math, footnotes, ids (Л6)", () => {
  it("draws a pair of tags as its element and mutes a lone tag", () => {
    expect(present('Keys <kbd>⌘</kbd>, <abbr title="Hyper Text">HT</abbr> and <span>x')).toEqual(sorted([
      'conceal "</abbr>"',
      'conceal "</kbd>"',
      'conceal "<abbr title=\\"Hyper Text\\">"',
      'conceal "<kbd>"',
      'mark abbr[title=Hyper Text] "HT"',
      'mark kbd "⌘"',
      'mute "<span>"',
    ]));
  });

  it("hides an escape's backslash", () => {
    expect(present("a \\* b")).toEqual(['conceal "\\\\"']);
  });

  it("draws a formula in a line and shows its source under the caret", () => {
    expect(present("so $x^2$ is")).toEqual(['widget {"kind":"math","source":"x^2"} "$x^2$"']);
    expect(present("so $x‸^2$ is")).toEqual(['mark span "$x^2$"', 'mute "$"', 'mute "$"']);
  });

  it("numbers footnotes in the order of their first reference, as GFM does", () => {
    expect(present("A[^b] and B[^a] and [^none].\n\n[^a]: First.\n[^b]: Second.")).toEqual(sorted([
      'mute "[^a]:"',
      'mute "[^b]:"',
      'widget {"kind":"footnote","number":1} "[^b]"',
      'widget {"kind":"footnote","number":2} "[^a]"',
    ]));
  });

  it("mutes a block id", () => {
    expect(present("A paragraph ^abc")).toEqual(['mute "^abc"']);
  });
});

describe("lists and tasks (Л7)", () => {
  it("wraps a list, hides its markers and draws a task's box in their place", () => {
    expect(present("- one\n- [ ] task\n- [x] done")).toEqual(sorted([
      'conceal "- "',
      `line ${LIST_ITEM_LINE_CLASS} @1`,
      `line ${LIST_ITEM_LINE_CLASS} checked=false @2`,
      `line ${LIST_ITEM_LINE_CLASS} checked=true @3`,
      `mark span.${TASK_DONE_CLASS} "done"`,
      'widget {"kind":"task","checked":false,"item":6} "- [ ] "',
      'widget {"kind":"task","checked":true,"item":17} "- [x] "',
      "wrapper ul.contains-task-list @1",
    ]));
  });

  it("shows a task's source only with the caret inside its box", () => {
    expect(present("- [‸ ] task")).toContain('mute "- [ ] "');
    expect(present("- [ ] ‸task")).toContain('widget {"kind":"task","checked":false,"item":0} "- [ ] "');
    expect(present("- [‸ ] task")).toContain(`line ${LIST_ITEM_LINE_CLASS} ${LIST_SOURCE_CLASS} checked=false @1`);
  });

  it("keeps the number a list starts at and the indentation of nested items to their wrapper", () => {
    expect(present("3. three\n4. four\n   - nested")).toEqual(sorted([
      'conceal "   - "',
      'conceal "3. "',
      'conceal "4. "',
      `line ${LIST_ITEM_LINE_CLASS} @1`,
      `line ${LIST_ITEM_LINE_CLASS} @2`,
      `line ${LIST_ITEM_LINE_CLASS} @3`,
      "wrapper ol[start=3] @1",
      "wrapper ul @3",
    ]));
  });
});

describe("quotes, rules, line endings (Л6, Л0.3)", () => {
  it("wraps a quote and hides `>` except on the caret's line", () => {
    expect(present("> one\n> two")).toEqual(['conceal "> "', 'conceal "> "', "wrapper blockquote @1"]);
    expect(present("> o‸ne\n> two")).toEqual(['conceal "> "', 'mute "> "', "wrapper blockquote @1"]);
  });

  it("draws a rule, and its source on the caret's line", () => {
    expect(present("a\n\n---\n\nb")).toContain('widget {"kind":"rule"} "---"');
    expect(present("a\n\n--‸-\n\nb")).toContain('mute "---"');
  });

  it("hides the \\r that ends a line of a mixed body", () => {
    expect(present("one\r\ntwo\nthree")).toEqual(['conceal "\\r"']);
  });
});

describe("blocks (Л5.3, Л6)", () => {
  it("leaves a block drawn as a widget to its widget and styles a revealed one as source", () => {
    const body = "```js\nlet x;\n```\n\ntext **b**";
    expect(present(body)).toEqual(['conceal "**"', 'conceal "**"', 'mark strong "**b**"']);
    expect(present(body, { revealedBlocks: [0] })).toEqual(sorted([
      'conceal "**"',
      'conceal "**"',
      `line ${SOURCE_BLOCK_CLASS} cm-md-source-first @1`,
      `line ${SOURCE_BLOCK_CLASS} @2`,
      `line ${SOURCE_BLOCK_CLASS} cm-md-source-last @3`,
      'mark strong "**b**"',
      'mute "```"',
      'mute "```"',
      'mute "js"',
    ]));
  });

  it("keeps the source of the embed shown above the body (Л2.7)", () => {
    expect(present("Text ![[clip.mp4]] more", { omittedEmbed: 5 })).toEqual(['mute "![[clip.mp4]]"']);
    expect(present("Text ![[photo.png]] more")).toEqual(['widget {"kind":"media","source":"![[photo.png]]"} "![[photo.png]]"']);
  });
});
