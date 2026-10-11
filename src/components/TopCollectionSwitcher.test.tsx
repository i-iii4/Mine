import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TagCount } from "@/types";
import { TopCollectionSwitcher } from "./TopCollectionSwitcher";

const LONG = "Красивый веб, который не помещается в путь целиком";
const TAGS: TagCount[] = [
  { tag: LONG, count: 3 },
  { tag: "Design", count: 5 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSwitcher(currentTag?: string) {
  return render(
    <TopCollectionSwitcher
      currentTag={currentTag}
      orderedTags={TAGS}
      onNavigate={vi.fn()}
      onCreateCollection={vi.fn()}
    />,
  );
}

// One surface, one way (DESIGN_SYSTEM.md, «Растворение кромок»,
// 11.10.2026): the collection in the path dissolves, as a tab's label does;
// the rows of its menu keep their ellipsis.
describe("TopCollectionSwitcher in the path", () => {
  it("dissolves the collection's name only when it does not fit", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === LONG ? 500 : 0;
    });
    const { rerender } = renderSwitcher();
    const everything = screen.getByRole("button", { name: "Switch collection: Everything" });
    expect(within(everything).getByText("Everything")).toHaveAttribute("data-fade-text");
    expect(within(everything).getByText("Everything")).not.toHaveAttribute("data-overflow");

    rerender(
      <TopCollectionSwitcher currentTag={LONG} orderedTags={TAGS} onNavigate={vi.fn()} onCreateCollection={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: `Switch collection: ${LONG}` });
    const label = within(trigger).getByText(LONG);
    expect(label).toHaveAttribute("data-overflow", "true");
    expect(label).not.toHaveClass("truncate");
  });

  it("keeps the mask on the text and the whole name in the hover hint", () => {
    renderSwitcher(LONG);
    const trigger = screen.getByRole("button", { name: `Switch collection: ${LONG}` });
    expect(trigger).toHaveAttribute("title", LONG);
    const masked = trigger.querySelectorAll("[data-fade-text]");
    expect(masked).toHaveLength(1);
    expect(masked[0]).toHaveTextContent(LONG);
    // The plate lights on hover around the text; the chevron follows it.
    expect(masked[0]?.parentElement).toHaveAttribute("data-chrome-plate");
    expect(masked[0]?.parentElement).not.toHaveAttribute("data-fade-text");
    expect(trigger.querySelector("[data-menu-chevron]")?.closest("[data-fade-text]")).toBeNull();
  });

  it("keeps the ellipsis in its menu's rows", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: "Switch collection: Everything" }));
    const row = await screen.findByRole("menuitem", { name: "Design" });
    expect(within(row).getByText("Design")).toHaveClass("truncate");
    expect(row.querySelector("[data-fade-text]")).toBeNull();
  });
});
