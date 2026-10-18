import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DisclosureRoot, DisclosureSummary } from "./Disclosure";

function renderDisclosure(defaultOpen = false) {
  return render(
    <DisclosureRoot defaultOpen={defaultOpen}>
      <DisclosureSummary>More</DisclosureSummary>
      <p>Inside</p>
    </DisclosureRoot>,
  );
}

// SPEC_READING_MODE.md, Ч4, Ч8: one disclosure for `<details>` and folding
// callouts, without animation, by a click, Enter and Space.
describe("Disclosure", () => {
  it("starts as the note says", () => {
    expect(renderDisclosure(true).container.querySelector("details")?.open).toBe(true);
  });

  it("toggles by a click and turns its chevron down while open", () => {
    const { container } = renderDisclosure();
    const chevron = container.querySelector("[data-disclosure-chevron]");
    expect(chevron).not.toHaveClass("rotate-90");
    fireEvent.click(screen.getByText("More"), { detail: 1 });
    expect(container.querySelector("details")?.open).toBe(true);
    expect(chevron).toHaveClass("rotate-90");
    expect(container.querySelector("summary")).toHaveAttribute("aria-expanded", "true");
  });

  it("toggles by Enter and Space, once per key", () => {
    const { container } = renderDisclosure();
    const summary = container.querySelector("summary")!;
    fireEvent.keyDown(summary, { key: "Enter" });
    fireEvent.click(summary, { detail: 0 });
    expect(container.querySelector("details")?.open).toBe(true);
    fireEvent.keyDown(summary, { key: " " });
    fireEvent.keyUp(summary, { key: " " });
    expect(container.querySelector("details")?.open).toBe(false);
    fireEvent.keyDown(summary, { key: "a" });
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("draws a summary outside a disclosure as written", () => {
    const { container } = render(<DisclosureSummary>Alone</DisclosureSummary>);
    expect(container.querySelector("summary")).not.toHaveAttribute("data-disclosure-summary");
    expect(container.querySelector("[data-disclosure-chevron]")).toBeNull();
  });
});
