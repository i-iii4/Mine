import { useEffect, useState } from "react";
import { renderMath, type MathRender } from "@/lib/reading/math";
import { logFailure } from "@/lib/appLog";
import { CodeBlock } from "./CodeBlock";

/** The log line of KaTeX that could not load: formulas stay as source. */
export const MATH_LOAD_FAILED_TITLE = "Could not load the formula renderer";

/** A formula's source in a line, shown until KaTeX draws it or when it
 *  cannot: code in a line, in the same monospace (Ч2, Ч9). */
function InlineSource({ source, title }: { source: string; title?: string }) {
  return (
    <code data-math-source="" title={title}>
      {source}
    </code>
  );
}

/**
 * A formula of the article (SPEC_READING_MODE.md, Ч9), drawn by KaTeX, which
 * loads on demand with its fonts. Until it comes, and when KaTeX cannot read
 * the formula, the source stands in its place: in a line as code in a line,
 * on a line of its own as a code block, with KaTeX's message in `title`. A
 * formula on its own line stands centred and scrolls inside its block.
 */
export function MathView({ source, display }: { source: string; display: boolean }) {
  const [result, setResult] = useState<{ source: string; display: boolean; render: MathRender } | null>(null);

  useEffect(() => {
    let current = true;
    renderMath(source, { display }).then(
      (render) => {
        if (current) setResult({ source, display, render });
      },
      (error: unknown) => logFailure(MATH_LOAD_FAILED_TITLE, error),
    );
    return () => {
      current = false;
    };
  }, [source, display]);

  const render = result && result.source === source && result.display === display ? result.render : null;
  const failure = render?.kind === "failed" ? render.message : undefined;

  if (display) {
    if (render?.kind !== "rendered") {
      return <CodeBlock code={source} title={failure} />;
    }
    return (
      <div
        className="not-prose my-5 overflow-x-auto text-center [overflow-wrap:normal]"
        data-math-display=""
        dangerouslySetInnerHTML={{ __html: render.html }}
      />
    );
  }
  if (render?.kind !== "rendered") return <InlineSource source={source} title={failure} />;
  return <span data-math-inline="" dangerouslySetInnerHTML={{ __html: render.html }} />;
}
