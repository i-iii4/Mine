import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SIDEBAR_FIELD_MIN_WIDTH_PX, useSidebarRowFit, type SidebarRowFit } from "./useSidebarRowFit";

// The field's width at each stage, as the layout would give it.
function Row({ widths }: { widths: Record<SidebarRowFit, number> }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const fit = useSidebarRowFit(rowRef, fieldRef, "key");
  return (
    <div ref={rowRef} data-row-fit={fit} data-testid="row">
      <input
        ref={(node) => {
          fieldRef.current = node;
          if (node) {
            node.getBoundingClientRect = () => {
              const stage = (rowRef.current?.dataset.rowFit ?? "full") as SidebarRowFit;
              return { width: widths[stage] } as DOMRect;
            };
          }
        }}
      />
      <span data-testid="fit">{fit}</span>
    </div>
  );
}

describe("the sidebar's filter row fit (DESIGN_SYSTEM.md, «Сжатие ряда фильтра»)", () => {
  const min = SIDEBAR_FIELD_MIN_WIDTH_PX;

  it("keeps everything while the field has its minimum", () => {
    render(<Row widths={{ full: min, name: min, icons: min, search: 0 }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("full");
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "full");
  });

  it("narrows the name first, then turns segments into icons", () => {
    const { unmount } = render(<Row widths={{ full: min - 1, name: min, icons: min, search: 0 }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("name");
    unmount();
    render(<Row widths={{ full: 10, name: min - 1, icons: min + 20, search: 0 }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("icons");
  });

  it("folds the field when even icons leave it short", () => {
    render(<Row widths={{ full: 0, name: 0, icons: min - 1, search: 0 }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("search");
  });
});
