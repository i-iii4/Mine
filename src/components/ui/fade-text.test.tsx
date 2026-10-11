import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDGE_FADE_WIDTH } from "@/lib/edgeFade";
import { FadeText } from "./fade-text";

const LONG = "A name far too long for its strip of chrome";

/** jsdom lays nothing out: the long text alone runs past its box. */
function overflowLongText() {
  return vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.textContent === LONG ? 500 : 0;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FadeText (DESIGN_SYSTEM.md, «Растворение кромок»)", () => {
  it("dissolves a text that does not fit, and only such a text", () => {
    overflowLongText();
    render(
      <>
        <FadeText text="Mine" />
        <FadeText text={LONG} />
      </>,
    );
    const short = screen.getByText("Mine");
    const long = screen.getByText(LONG);
    for (const label of [short, long]) {
      expect(label).toHaveAttribute("data-fade-text");
      // One line that clips, never an ellipsis.
      expect(label).toHaveClass("min-w-0", "overflow-hidden", "whitespace-nowrap");
      expect(label).not.toHaveClass("truncate", "text-ellipsis");
    }
    expect(short).not.toHaveAttribute("data-overflow");
    expect(long).toHaveAttribute("data-overflow", "true");
  });

  it("measures again when the text changes", () => {
    overflowLongText();
    const { rerender } = render(<FadeText text="Mine" />);
    expect(screen.getByText("Mine")).not.toHaveAttribute("data-overflow");
    rerender(<FadeText text={LONG} />);
    expect(screen.getByText(LONG)).toHaveAttribute("data-overflow", "true");
    rerender(<FadeText text="Mine" />);
    expect(screen.getByText("Mine")).not.toHaveAttribute("data-overflow");
  });

  it("measures again when its box resizes: a narrower window, sidebar or tab", () => {
    const observed: { callback: ResizeObserverCallback; target: Element | null }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      private readonly entry: { callback: ResizeObserverCallback; target: Element | null };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, target: null };
        observed.push(this.entry);
      }
      observe(target: Element) { this.entry.target = target; }
      unobserve() {}
      disconnect() { this.entry.target = null; }
    });
    let width = 600;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);

    render(<FadeText text={LONG} />);
    const label = screen.getByText(LONG);
    expect(label).not.toHaveAttribute("data-overflow");
    const watcher = observed.find((entry) => entry.target === label);
    expect(watcher).toBeDefined();

    width = 300;
    act(() => watcher!.callback([], {} as ResizeObserver));
    expect(label).toHaveAttribute("data-overflow", "true");

    width = 600;
    act(() => watcher!.callback([], {} as ResizeObserver));
    expect(label).not.toHaveAttribute("data-overflow");
  });

  it("passes the strip's own attributes and classes through", () => {
    render(<FadeText text="Mine" title="Mine" data-tab-label="" className="flex-1 font-mono" />);
    const label = screen.getByText("Mine");
    expect(label).toHaveAttribute("title", "Mine");
    expect(label).toHaveAttribute("data-tab-label");
    expect(label).toHaveClass("flex-1", "font-mono", "min-w-0");
  });
});

describe("the dissolve has one source", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("global.css masks the text alone over the edge fade width, only when it does not fit", () => {
    const css = read("src/styles/global.css");
    const rule = css.match(/\[data-fade-text\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/mask-image:\s*linear-gradient\(\s*to right,/);
    // Fallbacks: the clipper's overlay is a shadow root, which ignores @property.
    expect(rule).toContain("var(--fade-text-room, 0px)");
    expect(rule).toContain("var(--fade-text-ramp, 0px)");
    const overflow = css.match(/\[data-fade-text\]\[data-overflow="true"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(overflow).toContain(`--fade-text-ramp: ${EDGE_FADE_WIDTH}px;`);
    expect(css).toMatch(/@property --fade-text-ramp\s*\{[^}]*initial-value: 0px;/);
    expect(css).toMatch(/@property --fade-text-room\s*\{[^}]*initial-value: 0px;/);
  });

  it("the tab bar keeps no mask of its own, only the close button's room", () => {
    const css = read("src/tabbar/tabbar.css");
    expect(css).not.toMatch(/mask-image/);
    expect(css).not.toMatch(/--tab-fade|--tab-close-room/);
    expect(css).toMatch(/\[role="tab"\]:hover \[data-tab-label\],[^{]*\{[^}]*--fade-text-room: 30px;/);
  });
});
