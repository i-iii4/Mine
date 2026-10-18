import { useEffect, useRef, useState } from "react";
import { useThemeAppearance } from "@/hooks/useThemeAppearance";
import { useLightCanvas } from "@/lib/lightCanvas";
import { logFailure } from "@/lib/appLog";
import { readMermaidTheme, renderMermaid, type MermaidRender } from "@/lib/reading/mermaid";
import { CodeBlock } from "./CodeBlock";

/** The quiet line over a diagram Mermaid could not draw (Ч7, «Сбой»). */
export const MERMAID_FAILED_LINE = "Mermaid could not draw this diagram.";
/** The log line of Mermaid that could not load: the diagram stays as code. */
export const MERMAID_LOAD_FAILED_TITLE = "Could not load the diagram renderer";

interface DrawnDiagram {
  source: string;
  render: MermaidRender;
}

/**
 * A Mermaid diagram of the article (SPEC_READING_MODE.md, Ч7). While it is
 * drawn its source stands as a code block; the finished SVG replaces it,
 * centred and no wider than the column. A new theme (light or dark, or the
 * light canvas) draws it again, and the last drawing stays until the new one
 * comes. A diagram Mermaid cannot read or draw stays a code block under a
 * quiet line, Mermaid's message in its `title`: a state of the note, not a
 * failure of the app, so nothing turns red.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appearance = useThemeAppearance();
  const lightCanvas = useLightCanvas();
  const [drawn, setDrawn] = useState<DrawnDiagram | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let current = true;
    const theme = readMermaidTheme(host, appearance === "dark");
    renderMermaid(source, theme).then(
      (render) => {
        if (!current) return;
        setLoadFailed(false);
        setDrawn({ source, render });
      },
      (error: unknown) => {
        logFailure(MERMAID_LOAD_FAILED_TITLE, error);
        if (current) setLoadFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [appearance, lightCanvas, source]);

  const render = drawn?.source === source ? drawn.render : null;
  const failure = render?.kind === "failed" ? render.message : loadFailed ? MERMAID_LOAD_FAILED_TITLE : null;

  return (
    <div ref={hostRef} className="not-prose my-5" data-mermaid="">
      {render?.kind === "rendered" ? (
        <div
          className="flex justify-center"
          data-mermaid-diagram=""
          dangerouslySetInnerHTML={{ __html: render.svg }}
        />
      ) : (
        <>
          {failure !== null && (
            <p className="mb-2 text-sm text-muted-foreground" data-mermaid-failed="">
              {MERMAID_FAILED_LINE}
            </p>
          )}
          <CodeBlock code={source} title={failure ?? undefined} className="my-0" />
        </>
      )}
    </div>
  );
}
