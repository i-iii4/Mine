// The roles of motion (SPEC_MOTION_LEVELS.md, РД1 по РД8): every motion takes
// its time and its curve from its role's tokens, the level changes those
// tokens in one place, and the tokens' values in CSS and in code agree. The
// test reads the sources, in the manner of global.test.ts: CSS under src/,
// and TS and TSX under src/ without tests and the dev routes. The clipper's
// own sources (extension/) are not read: it follows the system alone (УД10).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CARD_PEEK_CENTER_SCALE, CARD_PEEK_MARGIN_PX, CARD_PEEK_NUDGE_SCALE } from "@/lib/cardPeek";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import {
  MOTION_EASE,
  MOTION_ENTER_MS,
  MOTION_EXIT_MS,
  MOTION_MENU_BLINK_MS,
  MOTION_MOVE_EASE,
  MOTION_MOVE_MS,
  MOTION_SPRING_MOVE_MS,
  MOTION_SURFACE_MS,
} from "@/lib/motion";

// ─── Sources ────────────────────────────────────────────────────────────────

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

const STYLESHEETS = sources("src", (file) => file.endsWith(".css"));

/** Code without tests, the tests' helpers and the dev routes (РД8, п. 2). */
const CODE = sources(
  "src",
  (file) => /\.(ts|tsx)$/.test(file)
    && !/\.test\.(ts|tsx)$/.test(file)
    && !file.startsWith("src/dev/")
    && !file.startsWith("src/test/"),
);

/** Code that keeps its own times, each for its reason (РД8, «Исключения»). */
const CODE_EXCEPTIONS: ReadonlyArray<{ file: RegExp; reason: string }> = [
  { file: /^src\/lib\/motion\.ts$/, reason: "the tokens' values for code (НС6)" },
  { file: /^src\/components\/graph\//, reason: "the graph keeps its motion on every level (УД9)" },
  { file: /^src\/components\/GraphView\.tsx$/, reason: "the graph keeps its motion on every level (УД9)" },
  { file: /^src\/lib\/(cardPeek|spring)\.ts$/, reason: "the springs and their shares (РД4)" },
];

function exempt(file: string): boolean {
  return CODE_EXCEPTIONS.some((exception) => exception.file.test(file));
}

// ─── A small CSS reader ─────────────────────────────────────────────────────

interface Declaration {
  property: string;
  value: string;
  /** The selector of the rule it stands in, nested rules joined by " >> ". */
  selector: string;
  file: string;
}

interface Rule {
  selector: string;
  declarations: Declaration[];
  file: string;
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every rule and declaration of a stylesheet, nesting included. At-rules
 *  with a block (`@media`, `@layer`, `@utility`, `@theme`, `@keyframes`) are
 *  read as rules of their own; statements (`@import`, `@custom-variant`) are
 *  skipped. */
function readCss(file: string, text: string): Rule[] {
  const css = stripCssComments(text);
  const rules: Rule[] = [];
  const readBlock = (start: number, end: number, parent: string): void => {
    let index = start;
    let chunk = "";
    let declarations: Declaration[] = [];
    const flushDeclaration = () => {
      const statement = chunk.trim();
      chunk = "";
      if (statement === "" || statement.startsWith("@")) return;
      const colon = statement.indexOf(":");
      if (colon <= 0) return;
      declarations.push({
        property: statement.slice(0, colon).trim(),
        value: statement.slice(colon + 1).trim(),
        selector: parent,
        file,
      });
    };
    let parenDepth = 0;
    while (index < end) {
      const char = css[index];
      if (char === "(") parenDepth += 1;
      if (char === ")") parenDepth -= 1;
      if (char === ";" && parenDepth === 0) {
        flushDeclaration();
        index += 1;
        continue;
      }
      if (char === "{") {
        const prelude = chunk.trim();
        chunk = "";
        let depth = 1;
        let close = index + 1;
        while (close < end && depth > 0) {
          if (css[close] === "{") depth += 1;
          if (css[close] === "}") depth -= 1;
          close += 1;
        }
        const selector = parent === "" ? prelude : `${parent} >> ${prelude}`;
        readBlock(index + 1, close - 1, selector);
        index = close;
        continue;
      }
      chunk += char;
      index += 1;
    }
    flushDeclaration();
    if (parent !== "" && declarations.length > 0) rules.push({ selector: parent, declarations, file });
    declarations = [];
  };
  readBlock(0, css.length, "");
  return rules;
}

const RULES = STYLESHEETS.flatMap(({ file, text }) => readCss(file, text));

/** The selectors of a list, split at its top-level commas. */
function selectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const char of selector) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(part.trim());
      part = "";
    } else part += char;
  }
  parts.push(part.trim());
  return parts.map((one) => one.replace(/\s+/g, " "));
}

/** What a press shows on Отклик's times, which Off stands at once: the one
 *  list beside the token block where Off sets Отклик's two tokens
 *  (SPEC_MOTION_LEVELS.md, «Режимы»). */
const OFF_PRESS_SELECTOR = '[data-motion="off"] :is( [data-radix-menu-content], .detail-top-bar-enter, .detail-top-bar-line-enter, .main-secondary-bar-layer, [data-top-row-fade], [data-sidebar-row-part], [data-slot="switch"], [data-slot="tabs-trigger"], [data-menu-chevron] )';

const TOKEN_SELECTORS = new Set([':root', '[data-motion="off"]', OFF_PRESS_SELECTOR]);

function inTokenBlock(declaration: Declaration): boolean {
  return declaration.file === "src/styles/global.css"
    && TOKEN_SELECTORS.has(declaration.selector.replace(/\s+/g, " "))
    && RULES.some((rule) => rule.selector === declaration.selector
      && rule.declarations.includes(declaration)
      && rule.declarations.some((other) => other.property.startsWith("--motion-")));
}

function tokenValue(selector: string, token: string): string | undefined {
  const rule = RULES.find((candidate) => candidate.file === "src/styles/global.css"
    && candidate.selector === selector
    && candidate.declarations.some((declaration) => declaration.property === "--motion-enter"
      || declaration.property === "--motion-move"
      || declaration.property === "--motion-surface-enter"));
  return rule?.declarations.find((declaration) => declaration.property === token)?.value;
}

// ─── What counts as a time or a curve ───────────────────────────────────────

const MOTION_PROPERTIES = new Set([
  "transition",
  "transition-duration",
  "transition-timing-function",
  "animation",
  "animation-duration",
  "animation-timing-function",
]);

/** A time with a unit, a curve, or a keyword curve, as a value writes it. */
const CSS_TIME = /(?<![\w.-])\d*\.?\d+m?s(?![\w-])/;
const CSS_CURVE = /cubic-bezier\(|(?<![\w-])linear\(|(?<![\w-])ease(-in|-out|-in-out)?(?![\w-])/;

/** The rules that keep their own times outside the roles, each for its
 *  reason (РД5, РД8, «Исключения»). Matched against the rule's selector. */
const CSS_EXCEPTIONS: ReadonlyArray<{ selector: RegExp; reason: string }> = [
  { selector: /^\[data-name-refused\]$/, reason: "the shake of a refused name, 320 ms on its own curve (В3)" },
  { selector: /^\.mine-progress-indeterminate$/, reason: "the progress without a length keeps moving (З1)" },
  { selector: /^\.mine-progress-fill$/, reason: "the fill of a progress follows the work, 300 ms ease-out, a status outside the roles (З2)" },
  { selector: /^\[data-motion="off"\] \.mine-progress-indeterminate$/, reason: "the progress breathes in place at Off (З1)" },
];

/** The rule «At once» (УД7): 0.01ms by a key and at Off, nothing else. */
function atOnceRule(declaration: Declaration): boolean {
  return declaration.selector.includes("[data-motion-key]")
    && /^0\.01ms !important$/.test(declaration.value)
    && (declaration.property === "transition-duration" || declaration.property === "animation-duration");
}

function cssException(declaration: Declaration): boolean {
  return CSS_EXCEPTIONS.some((exception) => exception.selector.test(declaration.selector.replace(/\s+/g, " ")));
}

// ─── A small TS reader: string literals without comments ────────────────────

interface Literal {
  text: string;
  /** Where it starts in the source. */
  index: number;
  /** A part of a template literal: the template's span, its interpolations
   *  included, once it is read whole. */
  template?: { start: number; end: number };
}

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** The string literals of a source, the static parts of template literals
 *  included, outside comments, and the source with comments blanked. */
function readCode(text: string): { literals: Literal[]; code: string } {
  const literals: Literal[] = [];
  let code = "";
  let index = 0;
  let lastSignificant = "";
  const templateDepths: number[] = [];
  const templates: Array<{ start: number; end: number }> = [];
  let braceDepth = 0;
  const readTemplate = () => {
    // At the character after the opening backtick or a closing `}` of `${`.
    let part = "";
    const start = index;
    const template = templates[templates.length - 1];
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        part += text.slice(index, index + 2);
        code += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === "`") {
        literals.push({ text: part, index: start, template });
        code += char;
        index += 1;
        if (template) template.end = index;
        templates.pop();
        lastSignificant = "`";
        return;
      }
      if (char === "$" && text[index + 1] === "{") {
        literals.push({ text: part, index: start, template });
        code += "${";
        index += 2;
        templateDepths.push(braceDepth);
        braceDepth += 1;
        lastSignificant = "{";
        return;
      }
      part += char;
      code += char;
      index += 1;
    }
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        code += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 ? text.length : close + 2;
      code += text.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      const start = index;
      index += 1;
      let value = "";
      while (index < text.length && text[index] !== char) {
        if (text[index] === "\\") {
          value += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (text[index] === "\n") break;
        value += text[index];
        index += 1;
      }
      index += 1;
      literals.push({ text: value, index: start });
      code += text.slice(start, index);
      lastSignificant = char;
      continue;
    }
    if (char === "`") {
      templates.push({ start: index, end: text.length });
      code += char;
      index += 1;
      readTemplate();
      continue;
    }
    if (char === "/" && (lastSignificant === "" || REGEX_BEFORE.has(lastSignificant) || /\b(return|typeof|case|in|of)$/.test(code.trimEnd()))) {
      // A regular expression: skip it whole, its class included.
      const start = index;
      index += 1;
      let inClass = false;
      while (index < text.length) {
        const current = text[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) {
          index += 1;
          break;
        } else if (current === "\n") break;
        index += 1;
      }
      while (index < text.length && /[a-z]/.test(text[index] ?? "")) index += 1;
      code += text.slice(start, index).replace(/[^\n]/g, " ");
      lastSignificant = "/";
      continue;
    }
    if (char === "{") braceDepth += 1;
    if (char === "}") {
      braceDepth -= 1;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
        templateDepths.pop();
        code += char;
        index += 1;
        readTemplate();
        continue;
      }
    }
    if (!/\s/.test(char ?? "")) lastSignificant = char ?? "";
    code += char;
    index += 1;
  }
  return { literals, code };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Tailwind classes that write a time or a curve as a number (РД8, п. 2). */
const TAILWIND_TIME = /(?<![\w-])duration-(\d|\[\d)/;
const TAILWIND_CURVE = /(?<![\w-])ease-(\[(?!var\(--motion-)|(in|out|in-out|linear)(?![\w-]))/;
/** A class that starts a transition or a tw-animate-css animation. */
const TAILWIND_MOTION = /(?<![\w-])(transition(?!-none)(-[\w[\](),.-]+)?|animate-in|animate-out)(?![\w-])/;
/** A role's time as a class, or a role's classes from motionClasses.ts. */
const ROLE_DURATION = /duration-\(--motion-|duration-\[var\(--motion-|\b(RESPONSE_ENTER_CLASS|RESPONSE_EXIT_CLASS|MOVE_CLASS|responseFadeClass)\b/;
/** A level's own variant in a class: the level changes only the tokens (РД6). */
const TAILWIND_LEVEL = /\[\[data-motion=/;
const LITERAL_MS = /(?<![\w.])\d+(\.\d+)?ms(?![\w-])/;

/** The class expression a literal stands in: the innermost call of `cn` or
 *  `cva` around it, or the literal alone. */
function classExpression(code: string, index: number): string {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = code[at];
    if (char === ")") depth += 1;
    if (char === "(") {
      if (depth === 0) {
        if (/\b(cn|cva|clsx)\s*$/.test(code.slice(Math.max(0, at - 8), at))) {
          let close = at + 1;
          let inner = 1;
          while (close < code.length && inner > 0) {
            if (code[close] === "(") inner += 1;
            if (code[close] === ")") inner -= 1;
            close += 1;
          }
          return code.slice(at, close);
        }
        return "";
      }
      depth -= 1;
    }
  }
  return "";
}

// ─── The checks ─────────────────────────────────────────────────────────────

interface Finding {
  where: string;
  what: string;
}

function cssFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const declaration of rule.declarations) {
      if (inTokenBlock(declaration)) continue;
      const where = `${declaration.file}: ${declaration.selector.replace(/\s+/g, " ").slice(0, 120)}`;
      if (declaration.property.startsWith("--")) {
        if (CSS_TIME.test(declaration.value) || /cubic-bezier\(|(?<![\w-])linear\(/.test(declaration.value)) {
          findings.push({ where, what: `${declaration.property}: ${declaration.value} (a variable of its own times, РД3)` });
        }
        continue;
      }
      if (!MOTION_PROPERTIES.has(declaration.property)) continue;
      if (cssException(declaration) || atOnceRule(declaration)) continue;
      if (CSS_TIME.test(declaration.value) || CSS_CURVE.test(declaration.value)) {
        findings.push({ where, what: `${declaration.property}: ${declaration.value}` });
      }
    }
  }
  return findings;
}

function codeFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const { file, text } of CODE) {
    if (exempt(file)) continue;
    const { literals, code } = readCode(text);
    for (const literal of literals) {
      const where = `${file}:${lineOf(text, literal.index)}`;
      const value = literal.text;
      if (TAILWIND_TIME.test(value)) findings.push({ where, what: `a time as a class: ${value.slice(0, 120)}` });
      if (TAILWIND_CURVE.test(value)) findings.push({ where, what: `a curve as a class: ${value.slice(0, 120)}` });
      if (TAILWIND_LEVEL.test(value)) findings.push({ where, what: `a level's variant: ${value.slice(0, 120)}` });
      if (LITERAL_MS.test(value)) findings.push({ where, what: `a time in a string: ${value.slice(0, 120)}` });
      if (value.includes("cubic-bezier(")) findings.push({ where, what: `a curve in a string: ${value.slice(0, 120)}` });
      if (TAILWIND_MOTION.test(value) && /\s|:/.test(value.trim()) && !ROLE_DURATION.test(value)) {
        const expression = literal.template
          ? code.slice(literal.template.start, literal.template.end)
          : classExpression(code, literal.index);
        if (!ROLE_DURATION.test(expression)) {
          findings.push({ where, what: `a transition with no role's time: ${value.slice(0, 120)}` });
        }
      }
    }
    for (const match of code.matchAll(/\.animate\(/g)) {
      let close = (match.index ?? 0) + ".animate(".length;
      let depth = 1;
      while (close < code.length && depth > 0) {
        if (code[close] === "(") depth += 1;
        if (code[close] === ")") depth -= 1;
        close += 1;
      }
      const call = code.slice(match.index, close);
      if (/\bduration\s*:\s*\d/.test(call)) {
        findings.push({ where: `${file}:${lineOf(text, match.index ?? 0)}`, what: "a number as the duration of .animate(" });
      }
    }
  }
  return findings;
}

/** The places a rule of the level may stand outside the token block
 *  (РД6): the rule «At once», and where the level changes what moves, not
 *  only its time. */
const LEVEL_SELECTORS = new Set([
  '[data-motion="off"]',
  // What a press shows on Отклик's times, at once at Off («Режимы»).
  OFF_PRESS_SELECTOR,
  // «At once» for the clipper alone, under the system's flag (УД10).
  '[data-motion-clipper][data-motion="off"] *:not(.mine-progress-indeterminate, .animate-spin, [data-name-refused])',
  '[data-motion-clipper][data-motion="off"] *::before',
  '[data-motion-clipper][data-motion="off"] *::after',
  // З1: the progress without a length breathes in place at Off.
  '[data-motion="off"] .mine-progress-indeterminate',
  // С7: the mark does not turn at Off.
  '[data-motion="off"] [data-sidebar-link-icon]',
]);

function levelRuleFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const part of selectorList(rule.selector.split(" >> ").pop() ?? "")) {
      if (!part.includes("[data-motion=")) continue;
      if (!LEVEL_SELECTORS.has(part)) findings.push({ where: rule.file, what: part });
    }
  }
  return findings;
}

function milliseconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

describe("the roles of motion (SPEC_MOTION_LEVELS.md, РД8)", () => {
  it("has sources to read", () => {
    expect(STYLESHEETS.map(({ file }) => file)).toEqual(expect.arrayContaining([
      "src/styles/global.css",
      "src/styles/buttons.css",
      "src/tabbar/tabbar.css",
    ]));
    expect(CODE.map(({ file }) => file)).toEqual(expect.arrayContaining([
      "src/components/Grid.tsx",
      "src/components/ui/dropdown-menu.tsx",
    ]));
    expect(RULES.length).toBeGreaterThan(100);
  });

  it("finds the rules it lets through, so none of its exceptions is stale", () => {
    for (const exception of CSS_EXCEPTIONS) {
      const rule = RULES.find((candidate) => exception.selector.test(candidate.selector.replace(/\s+/g, " ")));
      expect(rule, exception.reason).toBeDefined();
      expect(rule?.declarations.some((declaration) => MOTION_PROPERTIES.has(declaration.property)), exception.reason).toBe(true);
    }
    expect(RULES.some((rule) => rule.declarations.some(atOnceRule))).toBe(true);
    for (const exception of CODE_EXCEPTIONS) {
      expect(CODE.some(({ file }) => exception.file.test(file)), exception.reason).toBe(true);
    }
  });

  it("writes no time or curve in CSS outside the roles' tokens (п. 1)", () => {
    expect(cssFindings()).toEqual([]);
  });

  it("writes no time or curve in code outside motion.ts and the springs (п. 2)", () => {
    expect(codeFindings()).toEqual([]);
  });

  it("writes rules of the level only in the token block, «At once» and the places of РД6 (п. 3)", () => {
    expect(levelRuleFindings()).toEqual([]);
  });

  it("keeps the tokens in CSS equal to motion.ts and HOVER_INTENT (п. 4)", () => {
    expect(milliseconds(tokenValue(":root", "--motion-enter"))).toBe(MOTION_ENTER_MS);
    expect(MOTION_ENTER_MS).toBe(HOVER_INTENT.fadeInMs);
    expect(milliseconds(tokenValue(":root", "--motion-exit"))).toBe(MOTION_EXIT_MS);
    expect(MOTION_EXIT_MS).toBe(HOVER_INTENT.fadeOutMs);
    expect(tokenValue(":root", "--motion-ease")).toBe(MOTION_EASE);
    expect(milliseconds(tokenValue(":root", "--motion-surface-enter"))).toBe(MOTION_SURFACE_MS);
    expect(milliseconds(tokenValue(":root", "--motion-surface-exit"))).toBe(MOTION_SURFACE_MS);
    expect(milliseconds(tokenValue(":root", "--motion-move"))).toBe(MOTION_MOVE_MS);
    // The calm move that stands in for a spring in Minimal is Перемещение
    // (РД4): one kind of motion, one value.
    expect(MOTION_SPRING_MOVE_MS).toBe(MOTION_MOVE_MS);
    expect(tokenValue(":root", "--motion-move-ease")).toBe(MOTION_MOVE_EASE);
    expect(milliseconds(tokenValue(":root", "--motion-menu-blink"))).toBe(MOTION_MENU_BLINK_MS);
  });

  it("changes no token in Minimal, and at Off stands at once only what a press shows («Режимы»)", () => {
    // Minimal has no block: it replaces the heavy motions of a press in code.
    expect(RULES.some((rule) => rule.selector.includes('[data-motion="minimal"]'))).toBe(false);
    // Off: Поверхность and Перемещение everywhere, Отклик only on what a
    // press shows. The lift, the wash and the menu's blink keep their times:
    // they answer the pointer and the focus, or are a sign.
    const off = RULES.find((rule) => rule.file === "src/styles/global.css" && rule.selector === '[data-motion="off"]'
      && rule.declarations.some((declaration) => declaration.property === "--motion-move"));
    const offTokens = Object.fromEntries((off?.declarations ?? []).map((declaration) => [declaration.property, declaration.value]));
    expect(offTokens).toEqual({
      "--motion-surface-enter": "0.01ms",
      "--motion-surface-exit": "0.01ms",
      "--motion-move": "0.01ms",
    });
    const press = RULES.find((rule) => rule.selector.replace(/\s+/g, " ") === OFF_PRESS_SELECTOR);
    expect(Object.fromEntries((press?.declarations ?? []).map((declaration) => [declaration.property, declaration.value]))).toEqual({
      "--motion-enter": "0.01ms",
      "--motion-exit": "0.01ms",
    });
  });

  it("keeps the card window's step on the line of its leaving (ОУ4)", () => {
    expect(tokenValue(":root", "--motion-shift")).toBe("calc(40px / 6)");
    expect(CARD_PEEK_MARGIN_PX).toBe(40);
    expect(Number(tokenValue(":root", "--motion-scale"))).toBe(CARD_PEEK_CENTER_SCALE);
    expect(CARD_PEEK_NUDGE_SCALE).toBeCloseTo(1 - (1 - CARD_PEEK_CENTER_SCALE) / 6, 10);
  });

  it("drops the old variables of the hover answers (РД3)", () => {
    for (const { file, text } of [...STYLESHEETS, ...CODE]) {
      expect(text, file).not.toMatch(/--hover-intent-(fade-in|fade-out|name-fade)/);
    }
  });
});
