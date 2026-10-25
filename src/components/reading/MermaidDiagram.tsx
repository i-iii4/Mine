import { useEffect, useRef, useState } from "react";
import { logFailure } from "@/lib/appLog";
import { readMermaidLayout, renderMermaid, type MermaidRender } from "@/lib/reading/mermaid";
import { CodeBlock } from "./CodeBlock";

/** The quiet line over a diagram Mermaid could not draw (Ч7, «Сбой»). */
export const MERMAID_FAILED_LINE = "Mermaid could not draw this diagram.";
/** The log line of the renderer that could not load: the diagram stays as
 *  code. */
export const MERMAID_LOAD_FAILED_TITLE = "Could not load the diagram renderer";

interface DrawnDiagram {
  source: string;
  render: MermaidRender;
}

/**
 * A Mermaid diagram of the article (SPEC_READING_MODE.md, Ч7), drawn by
 * Pele. While it is drawn its source stands as a code block; the finished SVG
 * replaces it, centred and no wider than the column. Its colours are CSS
 * variables of the theme, so a new theme recolours it without drawing it
 * again. A diagram Pele cannot read or draw stays a code block under a quiet
 * line, Pele's message in its `title`: a state of the note, not a failure of
 * the app, so nothing turns red.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<DrawnDiagram | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let current = true;
    renderMermaid(source, readMermaidLayout(host)).then(
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
  }, [source]);

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
