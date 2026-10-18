import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useEffect, useState, type FocusEvent, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { logFailure } from "@/lib/appLog";
import { highlightCode } from "@/lib/reading/highlight";
import { cn } from "@/lib/utils";
import { mediaControlsClasses } from "./mediaControls";

/** The log line of a code copy that failed (Ч6.3). */
export const COPY_CODE_FAILED_TITLE = "Could not copy the code";
/** The log line of grammars that could not load: the block stays plain. */
export const HIGHLIGHT_LOAD_FAILED_TITLE = "Could not load code highlighting";

/** A code block's box (Ч6.1): zone level 2, the card corner, 16 px inside,
 *  the system monospace at 12/20; long lines scroll inside it (Ч6.2). */
export const CODE_BLOCK_PRE_CLASSES =
  "m-0 overflow-x-auto whitespace-pre rounded-card bg-muted p-4 text-sm leading-5 text-foreground [font-family:var(--article-code-font)] [overflow-wrap:normal]";

function highlightedChildren(tree: Root): ReactNode {
  return toJsxRuntime(tree, { Fragment, jsx, jsxs });
}

/**
 * A code block of the article (SPEC_READING_MODE.md, Ч6): the box, the copy
 * button in its top right corner under the pointer and in keyboard focus, and
 * highlighting by the fence's language, which loads on demand. Until it comes
 * the code stands as plain text in the same font and size, so nothing moves
 * when it does; an unknown language or none stays plain.
 */
export function CodeBlock({
  code,
  language = null,
  children,
  className,
  title,
}: {
  /** The code as written, without its last line break: what Copy copies. */
  code: string;
  language?: string | null;
  /** What the block shows instead of `code` while it is not highlighted:
   *  the elements of a `<pre>` from HTML. */
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; tree: Root } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!language) return undefined;
    let current = true;
    highlightCode(code, language).then(
      (tree) => {
        if (current) setHighlighted(tree ? { code, language, tree } : null);
      },
      (error: unknown) => logFailure(HIGHLIGHT_LOAD_FAILED_TITLE, error),
    );
    return () => {
      current = false;
    };
  }, [code, language]);

  const tree = highlighted && highlighted.code === code && highlighted.language === language
    ? highlighted.tree
    : null;

  const leaveFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setCopied(false);
  };

  return (
    <div
      className={cn("not-prose group/detail-media relative my-5", className)}
      data-code-block=""
      data-code-language={language ?? undefined}
      title={title}
      onPointerLeave={() => setCopied(false)}
      onBlur={leaveFocus}
    >
      <pre className={CODE_BLOCK_PRE_CLASSES}>
        <code data-code-highlighted={tree ? "" : undefined}>
          {tree ? highlightedChildren(tree) : children ?? code}
        </code>
      </pre>
      <div className={mediaControlsClasses(false)} data-code-copy="">
        <Button
          type="button"
          variant="default"
          size="icon"
          aria-label="Copy"
          data-code-copy-button=""
          onClick={() => {
            copyTextToClipboard(code, COPY_CODE_FAILED_TITLE);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-[13px]" /> : <Copy className="size-[13px]" />}
        </Button>
      </div>
    </div>
  );
}
