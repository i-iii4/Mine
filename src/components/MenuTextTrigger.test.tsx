import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MenuTextTrigger } from "./MenuTextTrigger";

function renderChevronTrigger(menuState: "open" | "closed", surface: "topChrome" | "clipperHeader" = "topChrome") {
  const element = (state: "open" | "closed") => (
    <MenuTextTrigger label="Everything" aria-label="Switch collection" surface={surface} showChevron data-state={state} />
  );
  const view = render(element(menuState));
  const trigger = screen.getByRole("button", { name: "Switch collection" });
  return { ...view, trigger, setState: (state: "open" | "closed") => view.rerender(element(state)) };
}

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
    expect(trigger).toHaveClass("h-6", "min-w-0", "rounded-1", "gap-0", "pl-2", "pr-1", "text-base", "text-foreground");
    expect(trigger).not.toHaveClass("w-full", "border-b", "bg-accent");
    const icon = trigger.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon).toHaveClass("group-data-[state=open]:rotate-90", "shrink-0");
    // The name is a flex item of a flex plate, as in the top chrome's
    // ChromePlate, so a long one ends in an ellipsis before the chevron.
    const label = screen.getByText("Mine");
    expect(label).toHaveClass("min-w-0", "truncate");
    expect(label.parentElement).toHaveClass("inline-flex", "min-w-0", "max-w-full", "items-center");
    expect(label.parentElement?.nextElementSibling).toBe(icon);
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
    expect(trigger).toHaveClass("hover:state-active");
    expect(trigger).not.toHaveClass("hover:bg-component-fill-hover");
  });
});

describe("MenuTextTrigger in the top chrome with its menu open", () => {
  it("does not flash on press: the plate holding the chevron is left out of the press rule", () => {
    renderChevronTrigger("closed");
    const chevron = screen.getByRole("button", { name: "Switch collection" }).querySelector("[data-menu-chevron]");
    // global.css skips a chrome plate with `:has(> [data-menu-chevron])`.
    expect(chevron?.parentElement).toHaveAttribute("data-chrome-plate");
  });

  it("keeps the plate lit from the open menu, and from hover through the click that closes it", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    setState("open");
    expect(trigger).toHaveAttribute("data-state", "open");
    // No menu is modal, so the trigger keeps its hover under its own open
    // menu (src/lib/openMenus.ts): hover and the open state are the plate's
    // only lights.
    expect(trigger.querySelector("[data-chrome-plate]")).toHaveClass(
      "group-hover:state-active",
      "group-data-[state=open]:state-active",
    );
  });
});
