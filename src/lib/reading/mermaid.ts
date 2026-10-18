// Mermaid diagrams (SPEC_READING_MODE.md, Ч7). `mermaid` 12.1.0 loads by a
// dynamic import, only for an article that holds a diagram; it is part of the
// build, and nothing comes from the network (Mine's CSP would refuse it).
// Diagrams draw one at a time (`mermaid.render` keeps shared state), each with
// an id of its own, and the finished SVG is kept by text and theme for the
// life of the page.

import type { Mermaid, MermaidConfig } from "mermaid";

/** A diagram drawn, or why it was not. */
export type MermaidRender =
  | { kind: "rendered"; svg: string }
  | { kind: "failed"; message: string };

/** The colours and font a diagram is drawn with: the theme's tokens. */
export interface MermaidTheme {
  dark: boolean;
  fontFamily: string;
  /** The width of the block the diagram stands in: a Gantt chart is laid
   *  out to it, not to the width of the page Mermaid draws in. */
  width: number;
  /** Mermaid's theme variables, colours as `#rrggbb`. */
  variables: Readonly<Record<string, string>>;
}

/** Finished diagrams kept, the oldest used one goes first. */
export const MERMAID_CACHE_LIMIT = 64;
/** The longest diagram text Mermaid is given: its own default. Longer text
 *  shows as code (Ч7, «Сбой»). */
export const MERMAID_MAX_TEXT_SIZE = 50_000;
/** The message of a diagram whose text is longer than that. */
export const MERMAID_TEXT_TOO_LONG = "The diagram is longer than Mermaid draws.";
/** The size of a diagram's text, `--text-base`. */
const MERMAID_FONT_SIZE = "14px";
/** Mermaid's own secure keys, then the keys of colour and font: a directive
 *  inside a diagram does not change them (no values outside the palette),
 *  any other setting of its own it may. */
const MERMAID_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "fontFamily",
  "look",
];
const MERMAID_ID_PREFIX = "mine-mermaid-";

/** The tokens a diagram's variables take (Ч7, the table of variables). The
 *  muted step is read opaque, over the page: Mermaid's colour library cannot
 *  composite. Lines and frames carry the diagram's meaning, so they take the
 *  secondary text step, 4.5:1, not the interface's `--border`. */
const MERMAID_TOKEN_VARIABLES: ReadonlyArray<readonly [token: string, variables: readonly string[]]> = [
  ["--background", ["background", "edgeLabelBackground", "tertiaryColor"]],
  ["--card", ["primaryColor", "mainBkg"]],
  ["--muted", ["secondaryColor", "clusterBkg", "noteBkgColor"]],
  ["--foreground", ["primaryTextColor", "textColor", "noteTextColor", "titleColor"]],
  [
    "--muted-foreground-opaque",
    ["lineColor", "primaryBorderColor", "nodeBorder", "clusterBorder", "noteBorderColor"],
  ],
];

/** `color` as sRGB `#rrggbb`, laid over `under` on one pixel of a canvas;
 *  `null` where there is no canvas to ask. */
function srgbHex(context: CanvasRenderingContext2D, color: string, under: string): string | null {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = under;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  if (red === undefined || green === undefined || blue === undefined) return null;
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The theme a diagram inside `host` is drawn with: the tokens as the page
 * computes them there, read from a probe as the graph reads its own
 * (`readGraphCanvasTheme`), each made `#rrggbb` by one canvas pixel, because
 * Mermaid's colour library (`khroma`) cannot read `oklch()`.
 */
export function readMermaidTheme(host: HTMLElement, dark: boolean): MermaidTheme {
  const probe = host.ownerDocument.createElement("span");
  probe.style.position = "absolute";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.overflow = "hidden";
  probe.style.pointerEvents = "none";
  host.appendChild(probe);
  const canvas = host.ownerDocument.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const read = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const page = read("--background");
  const variables: Record<string, string> = {};
  for (const [token, names] of MERMAID_TOKEN_VARIABLES) {
    const hex = context ? srgbHex(context, read(token), page) : null;
    if (hex) for (const name of names) variables[name] = hex;
  }
  const fontFamily = getComputedStyle(host).fontFamily;
  probe.remove();
  return {
    dark,
    fontFamily,
    width: Math.round(host.clientWidth),
    variables: { ...variables, fontFamily, fontSize: MERMAID_FONT_SIZE },
  };
}

/** The settings of every diagram in `theme` (Ч7, «Настройка»): no HTML,
 *  clicks or scripts in labels, the base theme over the tokens, the classic
 *  look and dagre: Mermaid 12 defaults to ELK, which on a simple flowchart
 *  loads 2274 KB against dagre's 844 KB. A diagram that asks for
 *  `layout: elk` still gets it, in a chunk of its own. */
export function mermaidConfig(theme: MermaidTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_TEXT_SIZE,
    theme: "base",
    themeVariables: { ...theme.variables, darkMode: theme.dark },
    darkMode: theme.dark,
    fontFamily: theme.fontFamily,
    look: "classic",
    layout: "dagre",
    secure: MERMAID_SECURE_KEYS,
    ...(theme.width > 0 ? { gantt: { useWidth: theme.width } } : {}),
  };
}

function themeKey(theme: MermaidTheme): string {
  return JSON.stringify(theme);
}

let mermaid: Promise<Mermaid> | null = null;
let initializedTheme: string | null = null;
let renderSequence = 0;
let queueTail: Promise<unknown> = Promise.resolve();
const finished = new Map<string, MermaidRender>();
const pending = new Map<string, Promise<MermaidRender>>();

function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import("mermaid").then(
    (module) => module.default,
    (error: unknown) => {
      // A failed load is tried again by the next diagram, not remembered.
      mermaid = null;
      throw error;
    },
  );
  return mermaid;
}

function remember(key: string, result: MermaidRender) {
  finished.delete(key);
  finished.set(key, result);
  while (finished.size > MERMAID_CACHE_LIMIT) {
    const oldest = finished.keys().next().value;
    if (oldest === undefined) break;
    finished.delete(oldest);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The nodes Mermaid puts in the document while it draws `id`: the
 *  diagram, its enclosing `d…` box and the `i…` frame of the sandbox. */
function removeTemporaryNodes(id: string) {
  for (const nodeId of [id, `d${id}`, `i${id}`]) {
    document.getElementById(nodeId)?.remove();
  }
}

async function draw(source: string, theme: MermaidTheme): Promise<MermaidRender> {
  const engine = await loadMermaid();
  const key = themeKey(theme);
  if (initializedTheme !== key) {
    // Once per theme, not per diagram: the settings are the page's.
    engine.initialize(mermaidConfig(theme));
    initializedTheme = key;
  }
  try {
    await engine.parse(source);
  } catch (error) {
    return { kind: "failed", message: errorText(error) };
  }
  renderSequence += 1;
  const id = `${MERMAID_ID_PREFIX}${renderSequence}`;
  try {
    const { svg } = await engine.render(id, source);
    return { kind: "rendered", svg };
  } catch (error) {
    return { kind: "failed", message: errorText(error) };
  } finally {
    removeTemporaryNodes(id);
  }
}

/**
 * The SVG of the diagram `source` in `theme`, from the cache when drawn
 * before. Diagrams draw one at a time in the order asked; the same text and
 * theme asked twice draw once. A diagram Mermaid cannot read or draw, or one
 * longer than `MERMAID_MAX_TEXT_SIZE`, comes back `failed` with the reason.
 * Rejects only when Mermaid could not be loaded, which is not kept.
 */
export function renderMermaid(source: string, theme: MermaidTheme): Promise<MermaidRender> {
  if (source.length > MERMAID_MAX_TEXT_SIZE) {
    return Promise.resolve({ kind: "failed", message: MERMAID_TEXT_TOO_LONG });
  }
  const key = `${themeKey(theme)}\u0000${source}`;
  const done = finished.get(key);
  if (done) {
    remember(key, done);
    return Promise.resolve(done);
  }
  const waiting = pending.get(key);
  if (waiting) return waiting;
  const run = queueTail.then(() => draw(source, theme));
  queueTail = run.catch(() => undefined);
  const tracked = run.then(
    (result) => {
      pending.delete(key);
      remember(key, result);
      return result;
    },
    (error: unknown) => {
      pending.delete(key);
      throw error;
    },
  );
  pending.set(key, tracked);
  return tracked;
}

/** Forget every finished diagram and the settings; for tests. */
export function resetMermaidForTests(): void {
  finished.clear();
  pending.clear();
  mermaid = null;
  initializedTheme = null;
  renderSequence = 0;
  queueTail = Promise.resolve();
}
