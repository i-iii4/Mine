import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

// The pill (DESIGN_SYSTEM.md, «Пилюля»): every segmented switch of the app is
// shadcn's Tabs in Mine's `chrome` variant (user's decision of 07.10.2026).

const OPTIONS = [
  { value: "grid", label: "Grid", left: 0, width: 40 },
  { value: "graph", label: "Graph", left: 40, width: 48 },
] as const;

/** Layout stand-in: the list starts at 100px, each trigger sits where OPTIONS
 *  put it inside the list. */
function mockTriggerBoxes() {
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const option = OPTIONS.find((candidate) => candidate.label === this.textContent && this.getAttribute("role") === "tab");
    const left = option ? 100 + option.left : 100;
    const width = option ? option.width : 0;
    return { left, width, right: left + width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  return () => rect.mockRestore();
}

function Pill({ size, initial = "grid" }: { size?: "row" | "panel"; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs value={value} onValueChange={setValue} className="gap-0">
      <TabsList variant="chrome" size={size} aria-label="View mode">
        {OPTIONS.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>{option.label}</TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

const parts = () => {
  const list = screen.getByRole("tablist", { name: "View mode" });
  return {
    list,
    track: list.querySelector<HTMLElement>("[data-tabs-track]")!,
    button: list.querySelector<HTMLElement>("[data-tabs-indicator]")!,
    grid: screen.getByRole("tab", { name: "Grid" }),
    graph: screen.getByRole("tab", { name: "Graph" }),
  };
};

describe("the pill", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = mockTriggerBoxes();
  });
  afterEach(() => restore());

  it("is a track always lit, published as its segments' surface", () => {
    render(<Pill />);
    const { list, track } = parts();
    expect(list).toHaveClass("state-surface", "rounded-1", "p-0");
    // No hover plate: hovering the pill changes no background.
    expect(list.className).not.toMatch(/hover:state-/);
    expect(track).toHaveClass("state-active", "absolute", "inset-x-0", "h-[var(--tabs-pill-height)]", "rounded-1");
    expect(track).toHaveAttribute("aria-hidden", "true");
  });

  it("seats the chosen segment's button flush: as tall as the pill, over the chosen segment", () => {
    render(<Pill />);
    const { button, grid } = parts();
    expect(button).toHaveClass("bg-component-fill-inner", "h-[var(--tabs-pill-height)]", "rounded-1", "absolute", "left-0");
    expect(button.style.width).toBe("40px");
    expect(button.style.transform).toBe("translateX(0px)");
    // Placed on the first frame, not slid in.
    expect(button).not.toHaveAttribute("data-animate");
    // The segment itself paints no fill: the button under it does.
    expect(grid.className).not.toMatch(/bg-component-fill-inner/);
    expect(grid).toHaveClass("h-[var(--tabs-pill-height)]", "rounded-1");
  });

  it("slides the button to a new choice, motion-safe only", async () => {
    render(<Pill />);
    const { button, graph } = parts();
    act(() => {
      fireEvent.mouseDown(graph, { button: 0 });
    });
    expect(graph).toHaveAttribute("data-state", "active");
    await waitFor(() => expect(button.style.transform).toBe("translateX(40px)"));
    expect(button.style.width).toBe("48px");
    expect(button).toHaveAttribute("data-animate");
    // The transition lives behind motion-safe, so reduced motion moves it at once.
    const transitions = button.className.split(/\s+/).filter((name) => name.includes("transition") || name.includes("duration") || name.includes("ease-"));
    expect(transitions.length).toBeGreaterThan(0);
    for (const name of transitions) expect(name.startsWith("motion-safe:")).toBe(true);
    expect(button.className).toContain("motion-safe:data-[animate]:duration-150");
  });

  it("lights only the text of a segment under the pointer", () => {
    render(<Pill />);
    const { grid, graph } = parts();
    for (const segment of [grid, graph]) {
      expect(segment).toHaveClass("text-muted-foreground", "hover:text-foreground", "data-[state=active]:text-foreground");
      expect(segment.className).not.toMatch(/hover:(?:bg|state)-/);
      for (const name of segment.className.split(/\s+/).filter((item) => item.includes("transition"))) {
        expect(name.startsWith("motion-safe:")).toBe(true);
      }
    }
  });

  it("stands in a chrome row at the row's height, a 24px pill", () => {
    render(<Pill />);
    const { list } = parts();
    expect(list).toHaveAttribute("data-size", "row");
    expect(list).toHaveClass("chrome-control", "font-mono", "text-sm", "[--tabs-pill-height:var(--chrome-control-plate-height)]");
  });

  it("stands in the settings window and the clipper as a 32px pill", () => {
    render(<Pill size="panel" />);
    const { list } = parts();
    expect(list).toHaveAttribute("data-size", "panel");
    expect(list).toHaveClass("text-base", "[--tabs-pill-height:32px]");
    expect(list).not.toHaveClass("chrome-control");
  });

  it("keeps the registry's variants as shadcn drew them", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Registry">
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = screen.getByRole("tablist", { name: "Registry" });
    expect(list).toHaveClass("bg-muted");
    expect(list.querySelector("[data-tabs-track]")).toBeNull();
    expect(list.querySelector("[data-tabs-indicator]")).toBeNull();
  });
});
