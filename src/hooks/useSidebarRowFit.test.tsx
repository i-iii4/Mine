import { useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIDEBAR_FIELD_MIN_WIDTH_PX, useSidebarRowFit, type SidebarRowFit } from "./useSidebarRowFit";

// The field's width at the stage its row is at, as the layout would give it.
function mockFieldWidth(node: HTMLElement, width: (stage: SidebarRowFit) => number) {
  node.getBoundingClientRect = () => {
    const stage = (node.closest<HTMLElement>("[data-row-fit]")?.dataset.rowFit ?? "full") as SidebarRowFit;
    return { width: width(stage) } as DOMRect;
  };
}

function Row({ widths }: { widths: Record<SidebarRowFit, number> }) {
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const { fit, rowRef } = useSidebarRowFit(fieldRef, "key");
  return (
    <div ref={rowRef} data-row-fit={fit} data-testid="row">
      <input
        ref={(node) => {
          fieldRef.current = node;
          if (node) mockFieldWidth(node, (stage) => widths[stage]);
        }}
      />
      <span data-testid="fit">{fit}</span>
    </div>
  );
}

// The resize observers of the page; `deliver` reports the size of every
// observed row, as a frame of the page does after its layout.
const observers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  deliver() {
    if (this.targets.size === 0) return;
    const entries = [...this.targets].map((target) => ({ target }) as ResizeObserverEntry);
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
function deliverResizes() {
  act(() => {
    for (const observer of [...observers]) observer.deliver();
  });
}

describe("the sidebar's filter row fit (DESIGN_SYSTEM.md, «Сжатие ряда фильтра»)", () => {
  const min = SIDEBAR_FIELD_MIN_WIDTH_PX;

  it("keeps everything while the field has its minimum", () => {
    render(<Row widths={{ full: min, name: min }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("full");
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "full");
  });

  it("narrows the name when the field would fall short", () => {
    render(<Row widths={{ full: min - 1, name: min }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("name");
  });

  it("gives up nothing past the name: the field and `+` never go (07.10.2026)", () => {
    render(<Row widths={{ full: 0, name: min - 1 }} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("name");
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "name");
  });
});

describe("the row follows the sidebar after it opens again", () => {
  const saved = globalThis.ResizeObserver;
  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = saved;
    observers.clear();
  });

  // The row's width as the layout has it now: the sidebar's top segment
  // grows from 0 to its width over 200ms when the sidebar opens.
  const layout = { rowWidth: 313 };
  const fieldWidth = (stage: SidebarRowFit) =>
    Math.max(0, layout.rowWidth - (stage === "full" ? 140 : 120));

  // The app's page: while its space opens the header has no row; then the
  // row, whose field and actions go while the sidebar is collapsed.
  function Page({ ready, collapsed }: { ready: boolean; collapsed: boolean }) {
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const { fit, rowRef } = useSidebarRowFit(fieldRef, String(collapsed));
    if (!ready) return <p>Opening vault…</p>;
    return (
      <div ref={rowRef} data-row-fit={collapsed ? undefined : fit} data-testid="row">
        {!collapsed && (
          <input
            ref={(node) => {
              fieldRef.current = node;
              if (node) mockFieldWidth(node, fieldWidth);
            }}
          />
        )}
      </div>
    );
  }

  it("measures the row again when its width settles after the sidebar opens (stuck narrowed, 04.10.2026)", () => {
    layout.rowWidth = 313;
    const { rerender } = render(<Page ready={false} collapsed={false} />);
    rerender(<Page ready collapsed={false} />);
    deliverResizes();
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "full");

    rerender(<Page ready collapsed />);
    deliverResizes();

    // Open again: the measure on the change reads the segment at the start
    // of its width transition, when the row is still 0 wide.
    layout.rowWidth = 0;
    rerender(<Page ready collapsed={false} />);
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "name");

    // The transition ends: the row has its width again and keeps the name.
    layout.rowWidth = 313;
    deliverResizes();
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "full");
  });

  it("narrows and widens the name with a drag of the sidebar's edge", () => {
    layout.rowWidth = 313;
    const { rerender } = render(<Page ready={false} collapsed={false} />);
    rerender(<Page ready collapsed={false} />);
    deliverResizes();
    layout.rowWidth = 200;
    deliverResizes();
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "name");
    layout.rowWidth = 313;
    deliverResizes();
    expect(screen.getByTestId("row")).toHaveAttribute("data-row-fit", "full");
  });

  it("stops observing a row that leaves the page", () => {
    const { rerender } = render(<Page ready collapsed={false} />);
    expect([...observers].some((observer) => observer.targets.size > 0)).toBe(true);
    rerender(<Page ready={false} collapsed={false} />);
    expect([...observers].some((observer) => observer.targets.size > 0)).toBe(false);
  });
});
