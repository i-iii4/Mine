import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export type MenuRowSize = "default" | "clipper";
export type MenuListPadding = "compact" | "default";

export const MENU_ROW_HEIGHT_PX: Record<MenuRowSize, number> = {
  default: 32,
  clipper: 40,
};

export const MENU_LIST_PADDING_Y_PX: Record<MenuListPadding, number> = {
  compact: 4,
  default: 8,
};

const DEFAULT_MAX_VISIBLE_ROWS = 8;
const MIN_VISIBLE_ROWS = 1;

interface QuantizedMenuListHeightInput {
  rowCount: number;
  rowHeightPx: number;
  paddingYPx: number;
  maxRows: number;
  minRows?: number;
  availableHeightPx?: number | null;
  fixedHeightPx?: number;
}

export function quantizedMenuListMaxHeight({
  rowCount,
  rowHeightPx,
  paddingYPx,
  maxRows,
  minRows = MIN_VISIBLE_ROWS,
  availableHeightPx = null,
  fixedHeightPx = 0,
}: QuantizedMenuListHeightInput): number {
  const itemRows = Math.max(0, rowCount);
  if (itemRows === 0) return paddingYPx;

  const requestedRows = Math.min(itemRows, Math.max(minRows, maxRows));
  if (!availableHeightPx || availableHeightPx <= 0) {
    return requestedRows * rowHeightPx + paddingYPx;
  }

  const availableForRows = availableHeightPx - fixedHeightPx - paddingYPx;
  const rowsByViewport = Math.floor(availableForRows / rowHeightPx);
  const visibleRows = Math.max(
    minRows,
    Math.min(requestedRows, rowsByViewport),
  );

  return visibleRows * rowHeightPx + paddingYPx;
}

export function menuRowHeightStyle(rowSize: MenuRowSize): CSSProperties {
  return {
    "--menu-row-height": `${MENU_ROW_HEIGHT_PX[rowSize]}px`,
  } as CSSProperties;
}

function readPxVariable(style: CSSStyleDeclaration, name: string): number | null {
  const raw = style.getPropertyValue(name).trim();
  if (!raw.endsWith("px")) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function readAvailableHeight(element: HTMLElement): number | null {
  const style = window.getComputedStyle(element);
  return (
    readPxVariable(style, "--floating-menu-available-height") ??
    readPxVariable(style, "--radix-dropdown-menu-content-available-height") ??
    readPxVariable(style, "--radix-context-menu-content-available-height")
  );
}

function measuredFixedSiblingHeight(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return 0;

  return Array.from(parent.children).reduce((total, sibling) => {
    if (sibling === element || !(sibling instanceof HTMLElement)) return total;
    return total + sibling.getBoundingClientRect().height;
  }, 0);
}

interface QuantizedMenuScrollAreaProps {
  rowCount: number;
  children: ReactNode;
  rowSize?: MenuRowSize;
  paddingY?: MenuListPadding;
  maxRows?: number;
  className?: string;
  innerClassName?: string;
}

/**
 * Scroll area for dropdown lists whose visible height must always be a whole
 * number of rows. The list owns scrolling; headers and footers stay fixed.
 */
export function QuantizedMenuScrollArea({
  rowCount,
  children,
  rowSize = "default",
  paddingY = "default",
  maxRows = DEFAULT_MAX_VISIBLE_ROWS,
  className,
  innerClassName,
}: QuantizedMenuScrollAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeightPx = MENU_ROW_HEIGHT_PX[rowSize];
  const paddingYPx = MENU_LIST_PADDING_Y_PX[paddingY];
  const fallbackMaxHeight = quantizedMenuListMaxHeight({
    rowCount,
    rowHeightPx,
    paddingYPx,
    maxRows,
  });
  const [maxHeight, setMaxHeight] = useState(fallbackMaxHeight);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const updateMaxHeight = () => {
      const nextMaxHeight = quantizedMenuListMaxHeight({
        rowCount,
        rowHeightPx,
        paddingYPx,
        maxRows,
        availableHeightPx: readAvailableHeight(element),
        fixedHeightPx: measuredFixedSiblingHeight(element),
      });
      setMaxHeight(nextMaxHeight);
    };

    updateMaxHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateMaxHeight);
      return () => window.removeEventListener("resize", updateMaxHeight);
    }

    const observer = new ResizeObserver(updateMaxHeight);
    observer.observe(element);
    if (element.parentElement) {
      observer.observe(element.parentElement);
      for (const sibling of Array.from(element.parentElement.children)) {
        if (sibling instanceof HTMLElement && sibling !== element) {
          observer.observe(sibling);
        }
      }
    }
    window.addEventListener("resize", updateMaxHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMaxHeight);
    };
  }, [maxRows, paddingYPx, rowCount, rowHeightPx]);

  return (
    <div
      ref={scrollRef}
      className={cn("min-h-0 overflow-y-auto", className)}
      data-quantized-menu-scroll-area=""
      data-menu-row-size={rowSize}
      style={{
        ...menuRowHeightStyle(rowSize),
        maxHeight: `${maxHeight}px`,
      }}
    >
      <div className={innerClassName}>
        {children}
      </div>
    </div>
  );
}
