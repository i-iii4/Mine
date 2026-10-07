import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

// DESIGN_SYSTEM.md, Focus (button): keyboard focus is visible on every text
// action and every segment (SPEC_AUDIT_FIXES.md, А4.1).
describe("keyboard focus", () => {
  it.each(["default", "secondary", "destructive", "ghost", "link"] as const)("shows the ring on a %s button", (variant) => {
    render(<Button variant={variant}>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("focus-visible:outline-1", "focus-visible:outline-ring");
  });

  it("shows the ring on a segment of the pill", () => {
    render(
      <Tabs value="a" className="gap-0">
        <TabsList variant="chrome" aria-label="Mode">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    for (const segment of screen.getAllByRole("tab")) {
      expect(segment).toHaveClass("focus-visible:outline-1", "focus-visible:outline-ring");
      expect(segment).not.toHaveClass("focus-visible:outline-none");
    }
  });
});

// SPEC_COLOR_RULES.md, 3.6: hover takes the glyph one step brighter on every
// chrome icon button, whatever its plate (user's report of 07.10.2026).
describe("chrome icon glyph", () => {
  it.each(["hover", "always", "raised"] as const)("brightens on hover with a %s plate", (plate) => {
    render(
      <Button variant="chrome" size="chrome-icon" plate={plate} aria-label="New Collection" tooltip={false}>
        <svg className="lucide" />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "New Collection" });
    expect(button).toHaveClass("text-muted-foreground", "hover:text-foreground", "data-[state=open]:text-foreground");
    expect(button).not.toHaveClass("hover:text-muted-foreground");
  });
});
