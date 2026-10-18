// Code highlighting (SPEC_READING_MODE.md, Ч6.4): `lowlight` 3.3.0 with the
// `common` grammars of highlight.js, loaded on demand by the first code
// block. Its output is a hast tree of `hljs-*` classes, which the article's
// stylesheet colours; the language comes from the fence, never guessed.

import type { Root } from "hast";

type Lowlight = ReturnType<typeof import("lowlight").createLowlight>;

let lowlight: Promise<Lowlight> | null = null;

function loadLowlight(): Promise<Lowlight> {
  lowlight ??= import("lowlight").then(
    ({ common, createLowlight }) => createLowlight(common),
    (error: unknown) => {
      // A failed load is tried again by the next block, not remembered.
      lowlight = null;
      throw error;
    },
  );
  return lowlight;
}

/** The language name a fence's info string gives: its first word, in lower
 *  case (`ts`, `tsx`, `python`). */
export function codeLanguage(info: string | null | undefined): string | null {
  const name = info?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return name || null;
}

/**
 * The highlighted tree of `code` in `language`, or `null` when there is no
 * language or highlight.js does not know it (the block stays plain text).
 * Aliases resolve as highlight.js resolves them: `tsx` is TypeScript, `jsx`
 * JavaScript. Rejects only when the grammars could not be loaded.
 */
export async function highlightCode(code: string, language: string | null): Promise<Root | null> {
  if (!language) return null;
  const engine = await loadLowlight();
  if (!engine.registered(language)) return null;
  return engine.highlight(language, code);
}
