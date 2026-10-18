// Formulas (SPEC_READING_MODE.md, Ч9): KaTeX 0.16.47 and its stylesheet with
// fonts load on demand at the first formula; Vite puts the fonts in the
// build, so nothing comes from the network. One copy serves the article and
// Mermaid, which depends on `katex ^0.16.47`.

type Katex = typeof import("katex").default;

/** A formula drawn, or what KaTeX said of it. */
export type MathRender =
  | { kind: "rendered"; html: string }
  | { kind: "failed"; message: string };

let katex: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  katex ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => module.default,
    (error: unknown) => {
      // A failed load is tried again by the next formula, not remembered.
      katex = null;
      throw error;
    },
  );
  return katex;
}

/**
 * `source` drawn by KaTeX: in a line or `display` on a line of its own.
 * `throwOnError` so a formula KaTeX cannot read comes back as its message
 * (the element shows the source instead, Ч9), `strict: "ignore"` so Cyrillic
 * in a formula does not warn, `trust: false` (no `\href`, no
 * `\includegraphics`), HTML with MathML for a screen reader and for copying,
 * the default limits on size and macro expansion. Rejects only when KaTeX
 * could not be loaded.
 */
export async function renderMath(source: string, { display }: { display: boolean }): Promise<MathRender> {
  const engine = await loadKatex();
  try {
    return {
      kind: "rendered",
      html: engine.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      }),
    };
  } catch (error) {
    if (error instanceof engine.ParseError) return { kind: "failed", message: error.message };
    throw error;
  }
}
