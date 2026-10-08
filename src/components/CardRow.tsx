// A card as one line of a list (SPEC_SEARCH_OVERLAY.md, «Строка результата»):
// the micro thumbnail, the file name, then the note's text that does not
// repeat it, told apart by color alone, and the card's commands over the
// row's right end. Search results and the open card's Related notes are this
// one row (user's decision of 07.10.2026).

import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import {
  MicroPreviewThumbnail,
  type MicroPreviewModel,
} from "@/components/MicroPreviewThumbnail";
import {
  windowNameAroundMark,
  windowTextAroundMark,
  type MarkWindow,
  type SearchResultRow,
} from "@/lib/searchResultRow";
import { renderSearchHighlightedText } from "@/lib/searchHighlight";
import { cn } from "@/lib/utils";
import type { SearchMatch } from "@/types";

/**
 * The row's item: the thumbnail and the line, the geometry of a menu item.
 * The thumbnail and the padding make every row 44 px tall. The inline
 * padding is the row's `--card-row-pad-x`; the row's commands keep the same
 * distance from its right end.
 */
const CARD_ROW_ITEM_CLASSES = "flex cursor-default items-center gap-2 px-(--card-row-pad-x) py-1.5";

/**
 * One line (user's decision of 06.10.2026): the file name, then the note's
 * text, told apart by color alone and a small gap, no separator glyph. The
 * type is the Sidebar collection row's (`font-sans text-base`), so every row
 * has the same height.
 */
const CARD_ROW_LINE_CLASSES = "flex min-w-0 flex-1 items-baseline gap-1 font-sans text-base";

/**
 * With text after it, the name takes what it needs up to three quarters of
 * the line and truncates past that, so the text always starts. Alone, the
 * name takes the whole line.
 */
const NAME_SHARE = 0.75;
const nameWithTextStyle = { maxWidth: `${NAME_SHARE * 100}%` } as const;

/** Canvas widths and the laid-out line round differently by a pixel or so. */
const NAME_FIT_SLACK_PX = 2;

let nameMeasureContext: CanvasRenderingContext2D | null | undefined;

/** Widths in the element's own font, on one shared canvas. */
function measureInFontOf(element: HTMLElement): ((text: string) => number) | null {
  nameMeasureContext ??= document.createElement("canvas").getContext("2d");
  const context = nameMeasureContext;
  if (!context) return null;
  const style = getComputedStyle(element);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (text) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

/**
 * The row's name. When the line cuts the name before its first mark, the
 * name keeps its head and skips to the words that lead up to the mark
 * (`windowNameAroundMark`), so a result never hides why it matched.
 * A name alone on its line stops `endReservePx` short of the line's end
 * while the row's buttons stand there.
 */
function CardRowName({
  name,
  match,
  withText,
  endReservePx,
  muted,
}: {
  name: string;
  match: SearchMatch | null;
  withText: boolean;
  endReservePx: number;
  muted: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<MarkWindow | null>(null);
  const ranges = match && match.excerpt === name && match.ranges.length > 0 ? match.ranges : null;
  const reservePx = withText ? 0 : endReservePx;

  useLayoutEffect(() => {
    const span = ref.current;
    const line = span?.parentElement;
    if (!span || !line || !ranges) {
      setFitted(null);
      return;
    }
    const fit = () => {
      const lineWidth = line.clientWidth;
      const measure = lineWidth > 0 ? measureInFontOf(span) : null;
      if (!measure) {
        setFitted(null);
        return;
      }
      const room = (withText ? lineWidth * NAME_SHARE : lineWidth - reservePx) - NAME_FIT_SLACK_PX;
      setFitted(windowNameAroundMark(name, ranges, room, measure));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let observedWidth = line.clientWidth;
    const observer = new ResizeObserver(() => {
      if (line.clientWidth === observedWidth) return;
      observedWidth = line.clientWidth;
      fit();
    });
    observer.observe(line);
    return () => observer.disconnect();
  }, [name, ranges, reservePx, withText]);

  return (
    <span
      ref={ref}
      className={cn("min-w-0 truncate", muted ? "text-muted-foreground" : "text-foreground")}
      style={withText
        ? nameWithTextStyle
        : reservePx > 0 ? { maxWidth: `calc(100% - ${reservePx}px)` } : undefined}
      data-card-row-name=""
      data-card-row-name-window={fitted ? "" : undefined}
    >
      {fitted && match
        ? renderSearchHighlightedText(fitted.text, { ...match, excerpt: fitted.text, ranges: fitted.ranges })
        : renderSearchHighlightedText(name, match)}
    </span>
  );
}

/**
 * The row's text after the name. When the line cuts the text before its
 * first mark, the text starts at the words just before the mark
 * (`windowTextAroundMark`), as the name does, so a match in the note's text is
 * never hidden past the line's end (07.10.2026). Its room is its own width,
 * which follows the name's, less the buttons' reserve.
 */
function CardRowText({
  text,
  match,
  endReservePx,
}: {
  text: string;
  match: SearchMatch | null;
  endReservePx: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<MarkWindow | null>(null);
  const ranges = match && match.excerpt === text && match.ranges.length > 0 ? match.ranges : null;

  useLayoutEffect(() => {
    const span = ref.current;
    if (!span || !ranges) {
      setFitted(null);
      return;
    }
    const fit = () => {
      const spanWidth = span.clientWidth;
      const measure = spanWidth > 0 ? measureInFontOf(span) : null;
      if (!measure) {
        setFitted(null);
        return;
      }
      const room = spanWidth - endReservePx - NAME_FIT_SLACK_PX;
      setFitted(windowTextAroundMark(text, ranges, room, measure));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let observedWidth = span.clientWidth;
    const observer = new ResizeObserver(() => {
      if (span.clientWidth === observedWidth) return;
      observedWidth = span.clientWidth;
      fit();
    });
    observer.observe(span);
    return () => observer.disconnect();
  }, [text, ranges, endReservePx]);

  return (
    <span
      ref={ref}
      className="min-w-0 flex-1 truncate text-muted-foreground"
      style={endReservePx > 0 ? { paddingRight: endReservePx } : undefined}
      data-card-row-text=""
      data-card-row-text-window={fitted ? "" : undefined}
    >
      {fitted && match
        ? renderSearchHighlightedText(fitted.text, { ...match, excerpt: fitted.text, ranges: fitted.ranges })
        : renderSearchHighlightedText(text, match)}
    </span>
  );
}

/**
 * What the row is to its list: an `option` of a listbox the search field
 * drives, a button of its own, or a card that cannot open (a link to a note
 * that is gone), whose name is dimmed.
 */
export type CardRowItem =
  | { as: "option"; props: HTMLAttributes<HTMLDivElement> }
  | { as: "button"; props: ButtonHTMLAttributes<HTMLButtonElement> }
  | { as: "static" };

interface CardRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  row: SearchResultRow;
  preview: MicroPreviewModel | null;
  /** The row the keyboard or the pointer is on: the active layer. */
  active: boolean;
  item: CardRowItem;
  /** The card's commands (`CardRowActions`) over the row's right end. */
  actions?: ReactNode;
  /** What the line leaves free at its end while the commands show. */
  actionsReservePx?: number;
  /**
   * The row stands 4 px inside a framed box (the open card's Related notes)
   * and pads 4 px, not 8: its thumbnail and commands keep to the box's 8 px
   * inset, and its light stays off the frame.
   */
  framed?: boolean;
  rowRef?: Ref<HTMLDivElement>;
}

/**
 * The row is two layers: the item (the card itself, what a press opens) and,
 * over its right end, the card's commands. They are siblings, so a press on a
 * command never reaches the item and the item's accessible name stays the
 * card's own. The wrapper carries the active layer, so both stand on the
 * same surface. A button item's keyboard focus lights the same layer.
 */
export function CardRow({
  row,
  preview,
  active,
  item,
  actions,
  actionsReservePx = 0,
  framed = false,
  rowRef,
  className,
  ...rowProps
}: CardRowProps) {
  const content = (
    <>
      <div
        aria-hidden="true"
        className="size-8 shrink-0 overflow-hidden bg-component-fill"
      >
        {preview && (
          <MicroPreviewThumbnail
            preview={preview}
            loading="lazy"
            draggable={false}
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )}
      </div>
      <span className={CARD_ROW_LINE_CLASSES} data-card-row-line="">
        <CardRowName
          name={row.title}
          match={row.nameMatch}
          withText={row.text !== null}
          endReservePx={actionsReservePx}
          muted={item.as === "static"}
        />
        {row.text !== null && (
          <CardRowText text={row.text} match={row.textMatch} endReservePx={actionsReservePx} />
        )}
      </span>
    </>
  );

  return (
    <div
      ref={rowRef}
      role="none"
      className={cn(
        "relative rounded-1",
        framed ? "[--card-row-pad-x:var(--spacing-s1)]" : "[--card-row-pad-x:var(--spacing-s2)]",
        active && "state-active",
        item.as === "button" && "has-[:focus-visible]:state-active",
        className,
      )}
      data-card-row=""
      {...rowProps}
    >
      {item.as === "option" && (
        <div
          role="option"
          {...item.props}
          className={cn(CARD_ROW_ITEM_CLASSES, item.props.className)}
        >
          {content}
        </div>
      )}
      {item.as === "button" && (
        <button
          type="button"
          {...item.props}
          className={cn(CARD_ROW_ITEM_CLASSES, "w-full text-left outline-none", item.props.className)}
        >
          {content}
        </button>
      )}
      {item.as === "static" && <div className={CARD_ROW_ITEM_CLASSES}>{content}</div>}
      {actions}
    </div>
  );
}
