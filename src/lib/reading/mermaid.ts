// Mermaid diagrams (SPEC_READING_MODE.md, Ч7), drawn by Pele. `pele/lazy`
// loads by a dynamic import, only for an article that holds a diagram, and
// then the part of one diagram type at a time; it is part of the build, and
// nothing comes from the network (Mine's CSP would refuse it). Pele draws an
// SVG whose colours are CSS variables, which `article.css` ties to the
// theme's tokens: a new theme recolours a diagram without drawing it again.
// A diagram draws in well under a millisecond once its type is loaded, so
// nothing is cached; diagrams draw in the order asked, a few milliseconds of
// the main thread at a time.

import type { RenderOptions } from "pele";

/** A diagram drawn, or why it was not. */
export type MermaidRender =
  | { kind: "rendered"; svg: string }
  | { kind: "failed"; message: string };

/** What a diagram's layout depends on: Pele measures its text and fits it to
 *  the width at drawing time, so these are part of the drawing, unlike the
 *  colours. */
export interface MermaidLayout {
  /** The article's font, as the page computes it on the diagram's block. */
  fontFamily: string;
  /** The font of code in the article (`--article-code-font`). */
  fontFamilyMono: string;
  /** The width of the block the diagram stands in. */
  width: number;
}

/** The longest diagram text Pele is given: its own default. Longer text
 *  shows as code (Ч7, «Сбой»). */
export const MERMAID_MAX_TEXT_SIZE = 50_000;
/** The message of a diagram whose text is longer than that. */
export const MERMAID_TEXT_TOO_LONG = "The diagram is longer than Mermaid draws.";
/** The message of a drawing that is no SVG. */
export const MERMAID_NOT_SVG = "The diagram renderer gave no SVG.";
/** The size of a diagram's text, `--text-base`. */
const MERMAID_FONT_SIZE = 14;
/** How long diagrams draw one after another before the queue gives the main
 *  thread back: an article of a hundred diagrams does not stall a frame. */
const MERMAID_SLICE_MS = 8;

/** The settings Pele draws every diagram with (Ч7, «Настройка»): the
 *  article's fonts at `--text-base`, fitted to the block, and no links or
 *  pictures of any kind: a link would leave the app from a diagram, a picture
 *  would ask for a file. `safeDiagramSvg` holds the drawing to that again. */
export function mermaidOptions(layout: MermaidLayout): RenderOptions {
  return {
    fontFamily: layout.fontFamily,
    fontFamilyMono: layout.fontFamilyMono,
    fontSize: MERMAID_FONT_SIZE,
    ...(layout.width > 0 ? { maxWidth: layout.width } : {}),
    limit: MERMAID_MAX_TEXT_SIZE,
    links: false,
    images: false,
    linkSchemes: [],
    imageSchemes: [],
  };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The elements of a drawing: shapes, text and their groups. Anything else
 *  Pele could write (a picture, embedded HTML) is taken out with what it
 *  holds. */
const DRAWING_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc",
]);
/** A link: its contents stay, the link goes. */
const LINK_ELEMENT = "a";
/** Attributes that run code or ask for a resource. */
const UNSAFE_ATTRIBUTE = /^(?:on|href$|xlink:href$|src$)/i;

/**
 * `svg` holding only a drawing (Ч7, «Что Pele не даёт в SVG»), the second
 * guard behind Pele's own settings, so that a Pele that writes more than it
 * promises (1.2.0 kept a relative link or picture) still cannot: a link keeps
 * its contents and loses itself, so a click on a node goes nowhere; a
 * picture, embedded HTML or a script goes with what it holds; no attribute
 * runs code or names a resource. `null` when the text is no SVG at all.
 */
export function safeDiagramSvg(svg: string): string | null {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  const broken = parsed.getElementsByTagName("parsererror").length > 0;
  if (broken || root.namespaceURI !== SVG_NAMESPACE || root.localName !== "svg") return null;
  // From the last element to the first, so that a link's contents are seen
  // before the link gives them to its parent.
  for (const element of [...root.querySelectorAll("*")].reverse()) {
    if (element.namespaceURI === SVG_NAMESPACE && element.localName === LINK_ELEMENT) {
      element.replaceWith(...element.childNodes);
    } else if (element.namespaceURI !== SVG_NAMESPACE || !DRAWING_ELEMENTS.has(element.localName)) {
      element.remove();
    }
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (UNSAFE_ATTRIBUTE.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * The layout of a diagram inside `host`: the fonts the page computes there,
 * the code font read from a probe, and the block's width.
 */
export function readMermaidLayout(host: HTMLElement): MermaidLayout {
  const probe = host.ownerDocument.createElement("code");
  probe.style.position = "absolute";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.overflow = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.fontFamily = "var(--article-code-font)";
  host.appendChild(probe);
  const fontFamilyMono = getComputedStyle(probe).fontFamily;
  probe.remove();
  return {
    fontFamily: getComputedStyle(host).fontFamily,
    fontFamilyMono,
    width: Math.round(host.clientWidth),
  };
}

/** Pele's own reading of a directive, `%%{name: args}%%`: what it takes out
 *  of the text, the same expression, so that the text keeps everything Pele
 *  would have kept. */
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/** The directives that carry settings; `wrap` and the others stay. */
const SETTING_DIRECTIVES = new Set(["init", "initialize"]);
/** The opening or closing line of front matter, after its indentation. */
const FRONT_MATTER_FENCE = /^---[^\S\r\n]*$/;
/** The key of the settings in front matter. */
const FRONT_MATTER_CONFIG = /^(?:config|"config"|'config')[^\S\r\n]*:/;

/** `text` with each of its characters but the line breaks taken out, so that
 *  the lines after it keep their numbers in Pele's messages. */
function lineBreaksOf(text: string): string {
  return text.replace(/[^\r\n]/g, "");
}

/** Front matter without its top-level `config` key and the lines under it. */
function frontMatterWithoutConfig(lines: string[], indent: string): string[] {
  const kept: string[] = [];
  let inConfig = false;
  for (const line of lines) {
    const own = line.startsWith(indent) ? line.slice(indent.length) : line;
    const topLevel = own !== "" && !/^[\s}\],]/.test(own);
    if (topLevel) inConfig = FRONT_MATTER_CONFIG.test(own);
    kept.push(inConfig ? "" : line);
  }
  return kept;
}

/**
 * `source` without the settings a diagram gives itself (Ч7, «Настройка»):
 * the `init` and `initialize` directives and the `config` key of its front
 * matter. Pele takes no colour or font of Mermaid's themes from them, but
 * some settings still reach the drawing (`sankey.linkColor` paints links,
 * `gantt.fontSize` sizes text), and the colour law allows no value outside
 * the palette. The title and `displayMode` of the front matter stay, and so
 * does every line number.
 */
export function withoutDiagramSettings(source: string): string {
  const lines = source.split("\n");
  const first = lines[0] ?? "";
  const indent = /^[^\S\r\n]*/.exec(first)?.[0] ?? "";
  let text = source;
  if (FRONT_MATTER_FENCE.test(first.slice(indent.length).replace(/\r$/, ""))) {
    const close = lines.findIndex(
      (line, index) => index > 0 && line.startsWith(indent) && FRONT_MATTER_FENCE.test(line.slice(indent.length).replace(/\r$/, "")),
    );
    if (close > 0) {
      const body = frontMatterWithoutConfig(lines.slice(1, close), indent);
      text = [first, ...body, ...lines.slice(close)].join("\n");
    }
  }
  if (!text.includes("%%{")) return text;
  return text.replace(DIRECTIVE, (directive: string, named?: string, bare?: string) => {
    const name = (named ?? bare ?? "").toLowerCase();
    return SETTING_DIRECTIVES.has(name) ? lineBreaksOf(directive) : directive;
  });
}

type Pele = typeof import("pele/lazy");

let pele: Promise<Pele> | null = null;
let queueTail: Promise<unknown> = Promise.resolve();
let sliceStart = 0;

function loadPele(): Promise<Pele> {
  pele ??= import("pele/lazy").catch((error: unknown) => {
    // A failed load is tried again by the next diagram, not remembered.
    pele = null;
    throw error;
  });
  return pele;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Gives the main thread back once the diagrams drawn since the last time
 *  have taken their slice. */
async function yieldWhenSliceIsOver() {
  if (performance.now() - sliceStart < MERMAID_SLICE_MS) return;
  await new Promise<void>((resume) => setTimeout(resume, 0));
  sliceStart = performance.now();
}

async function draw(source: string, layout: MermaidLayout): Promise<MermaidRender> {
  const engine = await loadPele();
  const text = withoutDiagramSettings(source);
  let type: ReturnType<Pele["detectType"]> = null;
  try {
    type = engine.detectType(text);
  } catch {
    // Text whose type cannot be read: rendering below says why.
  }
  // The part of this diagram type; a failed load rejects, as a failed load
  // of Pele itself does.
  await engine.load(type);
  await yieldWhenSliceIsOver();
  try {
    const svg = safeDiagramSvg(engine.render(text, mermaidOptions(layout)).svg);
    return svg === null ? { kind: "failed", message: MERMAID_NOT_SVG } : { kind: "rendered", svg };
  } catch (error) {
    return { kind: "failed", message: errorText(error) };
  }
}

/**
 * The SVG of the diagram `source` laid out as `layout` says. Diagrams draw in
 * the order asked. A diagram Pele cannot read or draw, or one longer than
 * `MERMAID_MAX_TEXT_SIZE`, comes back `failed` with the reason. Rejects only
 * when Pele or the part of the diagram's type could not be loaded, which is
 * not kept.
 */
export function renderMermaid(source: string, layout: MermaidLayout): Promise<MermaidRender> {
  if (source.length > MERMAID_MAX_TEXT_SIZE) {
    return Promise.resolve({ kind: "failed", message: MERMAID_TEXT_TOO_LONG });
  }
  const run = queueTail.then(() => draw(source, layout));
  queueTail = run.catch(() => undefined);
  return run;
}

/** Forget the loaded engine and the queue; for tests. */
export function resetMermaidForTests(): void {
  pele = null;
  queueTail = Promise.resolve();
  sliceStart = 0;
}
