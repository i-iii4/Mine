import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { SegmentedControl } from "./segmented-control";

// DESIGN_SYSTEM.md, Focus (button): keyboard focus is visible on every text
// action and every segment (SPEC_AUDIT_FIXES.md, А4.1).
describe("keyboard focus", () => {
  it.each(["default", "secondary", "destructive", "ghost", "link"] as const)("shows the ring on a %s button", (variant) => {
    render(<Button variant={variant}>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("focus-visible:outline-1", "focus-visible:outline-ring");
  });

  it("shows the ring on a segment", () => {
    render(
      <SegmentedControl
        value="a"
        options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
        onChange={() => undefined}
        aria-label="Mode"
      />,
    );
    for (const segment of screen.getAllByRole("button")) {
      expect(segment).toHaveClass("focus-visible:outline-1", "focus-visible:outline-ring");
      expect(segment).not.toHaveClass("focus-visible:outline-none");
    }
  });
});
