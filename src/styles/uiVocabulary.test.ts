// The dictionary of entities (DESIGN_SYSTEM.md, «Словарь сущностей»): every
// string a person reads says Space, Collection and Element. The old words
// `card(s)`, `block(s)`, `channel(s)` and `vault(s)` stay the names of the
// code, never of what is on screen or what a screen reader says.
//
// The test reads the sources, in the manner of motionRoles.test.ts: the
// page's TS and TSX under src/ without tests, their helpers and the dev
// routes, and the clipper under extension/ without its build output, its
// generated save core and the vendored Defuddle. In them a string is visible
// when it is:
// - JSX text, or a string a JSX child expression gives;
// - the value of an attribute a person reads or hears (VISIBLE_ATTRIBUTES);
// - the value of an object property that holds such words (VISIBLE_PROPERTIES);
// - prose anywhere: a string with a space and a letter, outside the
//   developer's console and the class lists.
// The macOS menu bar's own titles come from Rust: the menu the app builds,
// the Edit commands and the View item's sidebar title (RUST_MENU_SOURCES).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

/** An old word on its own: not a part of a class, an attribute, a path or a
 *  key such as `bg-card`, `data-block-slug`, `/channel/`, `Card.md`. */
const OLD_WORD = /(?<![-\w/.=[$#@])(?:cards?|blocks?|channels?|vaults?)(?![-\w/=\]]|\.\w)/i;

/** Attributes a person reads or a screen reader says. */
const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "caption",
  "description",
  "heading",
  "label",
  "placeholder",
  "title",
  "tooltip",
]);

/** Object properties whose value is a person's words: menu items, notices. */
const VISIBLE_PROPERTIES = new Set([
  "ariaLabel",
  "caption",
  "description",
  "heading",
  "hint",
  "label",
  "message",
  "placeholder",
  "text",
  "title",
  "tooltip",
]);

/** Calls whose string arguments nobody reads on screen. */
const SILENT_CALLEE = /^(?:console\.\w+|cn|cva|clsx|log\.\w+|logger\.\w+)$/;

/** Words of other products and of Markdown that only share a spelling with
 *  the old terms: the visible string keeps them. */
const FOREIGN_TERMS: ReadonlyArray<{ phrase: RegExp; reason: string }> = [
  { phrase: /\bYouTube channels?\b/i, reason: "a YouTube channel is YouTube's own entity, the author of a video" },
  { phrase: /\b(?:code|HTML|math|quote) blocks?\b/i, reason: "a Markdown block of the note's text, not an element" },
  { phrase: /\bblock (?:id|ids|reference|references)\b/i, reason: "Obsidian's block id `^id`, a part of a note" },
  { phrase: /\bdisplay:\s*block\b/i, reason: "a CSS value inside a style sheet the page writes" },
];

/** Visible strings that keep an old word, each for its reason. The file and
 *  the whole text are named, so a new string never hides behind an entry. */
const EXCEPTIONS: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  {
    file: "src/components/DetailView.tsx",
    text: "Could not load the open card ahead of the first card:",
    reason: "the title of a line in the developer's console, held in a constant (DETAIL_PRELOAD_FAILED_TITLE)",
  },
];

interface Source {
  file: string;
  text: string;
}

function sources(root: string, keep: (file: string) => boolean): Source[] {
  const found: Source[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const file = relative(process.cwd(), path);
        if (keep(file)) found.push({ file, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return found;
}

const NOT_SOURCE = /\.test\.(ts|tsx)$|\.fixtures\.ts$|\.d\.ts$/;

const PAGE = sources(
  "src",
  (file) => /\.(ts|tsx)$/.test(file)
    && !NOT_SOURCE.test(file)
    && !file.startsWith("src/dev/")
    && !file.startsWith("src/test/")
    && file !== "src/types/generated.ts",
);

const CLIPPER = sources(
  "extension",
  (file) => /\.(ts|tsx|js)$/.test(file)
    && !NOT_SOURCE.test(file)
    && !file.startsWith("extension/dist/")
    && !file.startsWith("extension/generated/")
    && file !== "extension/lib/defuddle.js",
);

interface Visible {
  file: string;
  line: number;
  text: string;
  /** Where the string stands: `jsx`, `attribute aria-label`, `prose`… */
  place: string;
}

/** The text of a string or a template, `${…}` for each substitution. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => "${…}" + span.literal.text).join("");
  }
  return null;
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  return call.expression.getText().replace(/\s+/g, "");
}

/** The attribute or the property the string is the value of, through the
 *  expressions that only choose between strings: `a ? "x" : "y"`, `a ?? "x"`,
 *  `{"x"}`, `("x")`. */
function owner(node: ts.Node): ts.Node | undefined {
  let current: ts.Node = node;
  let parent = current.parent;
  while (
    parent
    && (ts.isConditionalExpression(parent)
      || ts.isParenthesizedExpression(parent)
      || (ts.isBinaryExpression(parent) && parent.left !== current)
      || ts.isJsxExpression(parent)
      || ts.isAsExpression(parent))
  ) {
    current = parent;
    parent = current.parent;
  }
  return parent;
}

/** Inside a call whose arguments nobody reads, or inside a module name. */
function silent(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && SILENT_CALLEE.test(calleeName(parent))) {
      return true;
    }
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
    if (ts.isJsxAttribute(parent) && parent.name.getText() === "className") return true;
  }
  return false;
}

/** A list of classes: at least half of its words carry `-`, `:` or `[`,
 *  as `block min-w-0 text-sm` does and a sentence does not. Its `block` is
 *  the CSS display, not an element. */
function classList(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.filter((word) => /[-:[]/.test(word)).length * 2 >= words.length;
}

/** Prose: two words in a row that are not a list of classes. */
function prose(text: string): boolean {
  return /[A-Za-z]{2,} +[A-Za-z]/.test(text) && !classList(text);
}

function visibleStrings(source: Source): Visible[] {
  const kind = source.file.endsWith(".tsx") ? ts.ScriptKind.TSX : source.file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true, kind);
  const found: Visible[] = [];
  const add = (node: ts.Node, text: string, place: string) => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    found.push({ file: source.file, line, text, place });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (text) add(node, text, "jsx");
    } else {
      const text = literalText(node);
      if (text !== null && !silent(node)) {
        const at = owner(node);
        if (at && ts.isJsxAttribute(at)) {
          const name = at.name.getText();
          if (VISIBLE_ATTRIBUTES.has(name)) add(node, text, `attribute ${name}`);
          else if (prose(text) && !name.startsWith("data-")) add(node, text, `attribute ${name}`);
        } else if (at && ts.isJsxElement(at)) {
          add(node, text, "jsx");
        } else if (at && ts.isPropertyAssignment(at) && VISIBLE_PROPERTIES.has(at.name.getText().replace(/["']/g, ""))) {
          add(node, text, `property ${at.name.getText()}`);
        } else if (prose(text)) {
          add(node, text, "prose");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The old word the string says, after the foreign terms are taken out. */
function oldWord(text: string): string | null {
  let rest = text;
  for (const term of FOREIGN_TERMS) rest = rest.replace(new RegExp(term.phrase.source, "gi"), " ");
  return OLD_WORD.exec(rest)?.[0] ?? null;
}

function excepted(visible: Visible): boolean {
  return EXCEPTIONS.some((exception) => exception.file === visible.file && exception.text === visible.text);
}

function violations(found: readonly Source[]): string[] {
  return found
    .flatMap(visibleStrings)
    .filter((visible) => oldWord(visible.text) !== null && !excepted(visible))
    .map((visible) => `${visible.file}:${visible.line} (${visible.place}): ${JSON.stringify(visible.text)}`);
}

// ─── Rust: the macOS menu bar ───────────────────────────────────────────────

/** The functions that hold the menu bar's titles, by file. */
const RUST_MENU_SOURCES: ReadonlyArray<{ file: string; fn: string }> = [
  { file: "src-tauri/src/lib.rs", fn: "build_app_menu" },
  { file: "src-tauri/src/domain/edit_menu.rs", fn: "title" },
  { file: "src-tauri/src/commands/window_chrome.rs", fn: "sidebar_menu_title" },
];

/** The body of `fn name` in Rust source: from its `{` to the matching `}`. */
function rustFunctionBody(text: string, name: string): string {
  const start = new RegExp(`\\bfn ${name}\\b`).exec(text);
  if (!start) throw new Error(`fn ${name} is not there`);
  const open = text.indexOf("{", start.index);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`fn ${name} has no end`);
}

/** The string literals of Rust code, comments left out. */
function rustStrings(code: string): string[] {
  const withoutComments = code.replace(/\/\/[^\n]*/g, "");
  // The pattern has one group, always present in a match.
  return [...withoutComments.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
}

function rustMenuTitles(): Array<{ file: string; text: string }> {
  return RUST_MENU_SOURCES.flatMap(({ file, fn }) =>
    rustStrings(rustFunctionBody(readFileSync(file, "utf8"), fn)).map((text) => ({ file, text })),
  );
}

describe("the dictionary of entities in visible strings (DESIGN_SYSTEM.md, «Словарь сущностей»)", () => {
  it("finds the strings a person reads, so an empty answer means something", () => {
    // The check reads what it claims to read: a few known visible strings of
    // each kind are among the strings it takes for visible.
    const page = PAGE.flatMap(visibleStrings);
    const clipper = CLIPPER.flatMap(visibleStrings);
    expect(page.some((visible) => visible.place === "attribute aria-label" && visible.text === "Element actions")).toBe(true);
    expect(page.some((visible) => visible.place === "jsx" && /ESC to close element/.test(visible.text))).toBe(true);
    expect(page.some((visible) => visible.text === "Element view")).toBe(true);
    expect(clipper.some((visible) => /Element counts will appear shortly/.test(visible.text))).toBe(true);
    expect(rustMenuTitles().map((title) => title.text)).toEqual(expect.arrayContaining(["Find Elements", "Find Collections", "Undo", "Hide Sidebar"]));
  });

  it("takes an old word for a violation and leaves the words of the code alone", () => {
    expect(oldWord("Card actions")).toBe("Card");
    expect(oldWord("Delete 3 cards?")).toBe("cards");
    expect(oldWord("No vault selected")).toBe("vault");
    expect(oldWord("Channels")).toBe("Channels");
    expect(oldWord("rounded-card bg-card")).toBeNull();
    expect(oldWord("[data-block-slug]")).toBeNull();
    expect(oldWord("/channel/${…}")).toBeNull();
    expect(oldWord("Cards/Example.md")).toBeNull();
    expect(oldWord("Copy code block")).toBeNull();
    expect(oldWord("Open YouTube channel")).toBeNull();
  });

  it("keeps the old words out of the page's visible strings", () => {
    expect(violations(PAGE)).toEqual([]);
  });

  it("keeps the old words out of the clipper's visible strings", () => {
    expect(violations(CLIPPER)).toEqual([]);
  });

  it("keeps the old words out of the macOS menu bar", () => {
    expect(rustMenuTitles().filter((title) => oldWord(title.text) !== null)).toEqual([]);
  });

  it("names every exception by a string that is still there", () => {
    const all = [...PAGE, ...CLIPPER].flatMap(visibleStrings);
    for (const exception of EXCEPTIONS) {
      expect(all.some((visible) => visible.file === exception.file && visible.text === exception.text), exception.text).toBe(true);
    }
  });
});
