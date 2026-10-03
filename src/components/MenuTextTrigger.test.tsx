import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MenuTextTrigger } from "./MenuTextTrigger";

describe("MenuTextTrigger", () => {
  it("uses the top chrome inner pill state instead of a root button frame", () => {
    render(<MenuTextTrigger label="Mine" aria-label="Switch space: Mine" />);

    const trigger = screen.getByRole("button", { name: "Switch space: Mine" });
    expect(trigger).toHaveClass("chrome-control", "font-mono", "text-sm");
    expect(trigger).not.toHaveClass("border");

    const label = screen.getByText("Mine").closest("span");
    expect(label?.parentElement).toHaveClass("chrome-plate", "rounded-1", "px-2");
  });

  it("puts the top chrome chevron inside the pill, right after the name", () => {
    render(<MenuTextTrigger label="Mine" aria-label="Switch space: Mine" showChevron />);

    const trigger = screen.getByRole("button", { name: "Switch space: Mine" });
    const chevron = trigger.querySelector("[data-menu-chevron]");
    expect(chevron).not.toBeNull();
    // Its box's empty sides stand in for the gap and half the right padding.
    expect(chevron?.parentElement).toHaveClass("chrome-plate", "gap-0", "pl-2", "pr-1");
    expect(chevron?.parentElement).not.toHaveClass("gap-1", "px-2");
    expect(chevron?.previousElementSibling).toHaveTextContent("Mine");
    // Closed it points right; the open menu turns it down.
    expect(chevron).toHaveClass("lucide-chevron-right", "group-data-[state=open]:rotate-90");
  });

  it("draws no chevron in the top chrome unless asked, and keeps even padding then", () => {
    render(<MenuTextTrigger label="Mine" aria-label="Switch space: Mine" />);
    expect(screen.getByRole("button", { name: "Switch space: Mine" }).querySelector("svg")).toBeNull();
    expect(screen.getByText("Mine").parentElement).toHaveClass("px-2");
  });

  it("uses the clipper header trigger as a compact pill with an inline chevron", () => {
    render(
      <MenuTextTrigger
        label="Mine"
        aria-label="Switch space: Mine"
        surface="clipperHeader"
        showChevron
      />,
    );

    const trigger = screen.getByRole("button", { name: "Switch space: Mine" });
    expect(trigger).toHaveClass("h-6", "rounded-1", "gap-0", "pl-2", "pr-1", "text-base", "text-foreground");
    expect(trigger).not.toHaveClass("w-full", "border-b", "bg-accent");
    const icon = trigger.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon).toHaveClass("group-data-[state=open]:rotate-90");
  });

  it("uses the shared active surface in the action bar", () => {
    render(
      <MenuTextTrigger
        label="Actions"
        aria-label="Open actions"
        surface="actionBar"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open actions" });
    expect(trigger).toHaveClass("hover:bg-active");
    expect(trigger).not.toHaveClass("hover:bg-component-fill-hover");
  });
});
