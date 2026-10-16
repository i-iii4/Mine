import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FadeScrollRow } from "./FadeScrollRow";

/** Give jsdom, which lays out nothing, the row's scroll geometry. */
function geometry(
  row: HTMLElement,
  { scrollLeft, clientWidth, scrollWidth }: { scrollLeft: number; clientWidth: number; scrollWidth: number },
) {
  Object.defineProperty(row, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(row, "scrollWidth", { configurable: true, value: scrollWidth });
  row.scrollLeft = scrollLeft;
}

describe("FadeScrollRow: one row that scrolls sideways (SPEC_NARROW_WINDOW.md, У13)", () => {
  it("dissolves the edges where content is hidden, with the shared ramp", () => {
    const { container } = render(<FadeScrollRow data-row="">content</FadeScrollRow>);
    const row = container.querySelector<HTMLElement>("[data-row]");
    if (!row) throw new Error("no row");
    expect(row).toHaveClass("overflow-x-auto");
    expect(row.dataset.fadeLeft).toBeUndefined();
    expect(row.dataset.fadeRight).toBeUndefined();

    geometry(row, { scrollLeft: 0, clientWidth: 390, scrollWidth: 520 });
    fireEvent.scroll(row);
    expect(row.dataset.fadeLeft).toBeUndefined();
    expect(row.dataset.fadeRight).toBe("true");
    // The ramp itself is checked in Chromium (test:narrow-window): jsdom
    // drops mask images.

    geometry(row, { scrollLeft: 60, clientWidth: 390, scrollWidth: 520 });
    fireEvent.scroll(row);
    expect(row.dataset.fadeLeft).toBe("true");
    expect(row.dataset.fadeRight).toBe("true");

    geometry(row, { scrollLeft: 130, clientWidth: 390, scrollWidth: 520 });
    fireEvent.scroll(row);
    expect(row.dataset.fadeLeft).toBe("true");
    expect(row.dataset.fadeRight).toBeUndefined();
  });

  it("keeps the style it is given", () => {
    const { container } = render(<FadeScrollRow data-row="" style={{ gap: 8 }}>content</FadeScrollRow>);
    expect(container.querySelector<HTMLElement>("[data-row]")?.style.gap).toBe("8px");
  });
});
