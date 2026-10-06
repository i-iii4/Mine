import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MenuTextTrigger } from "./MenuTextTrigger";

// The trigger's box in the viewport, and a point in it and one outside.
const TRIGGER_BOX = { left: 10, top: 0, right: 110, bottom: 24, width: 100, height: 24, x: 10, y: 0, toJSON: () => ({}) };
const INSIDE = { clientX: 50, clientY: 12 };
const OUTSIDE = { clientX: 400, clientY: 300 };

function renderChevronTrigger(menuState: "open" | "closed", surface: "topChrome" | "clipperHeader" = "topChrome") {
  const element = (state: "open" | "closed") => (
    <MenuTextTrigger label="Everything" aria-label="Switch collection" surface={surface} showChevron data-state={state} />
  );
  const view = render(element(menuState));
  const trigger = screen.getByRole("button", { name: "Switch collection" });
  trigger.getBoundingClientRect = () => TRIGGER_BOX;
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

  it("keeps the plate lit while the pointer stays over it through the click that closes the menu", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    setState("open");
    expect(trigger).toHaveAttribute("data-state", "open");
    // The plate lights from the flag exactly as from hover and the open menu.
    expect(trigger.querySelector("[data-chrome-plate]")).toHaveClass(
      "group-hover:state-active",
      "group-data-[pointer-inside]:state-active",
      "group-data-[pointer-inside]:text-foreground",
      "group-data-[state=open]:state-active",
    );

    // The modal menu hides the trigger from hit testing: the pointer is
    // followed by geometry from the document.
    fireEvent.pointerMove(document.body, INSIDE);
    expect(trigger).toHaveAttribute("data-pointer-inside");
    // The closing press lands on the page root, over the trigger's box.
    fireEvent.pointerDown(document.documentElement, INSIDE);
    setState("closed");
    expect(trigger).toHaveAttribute("data-state", "closed");
    expect(trigger).toHaveAttribute("data-pointer-inside");
    fireEvent.pointerUp(document.documentElement, INSIDE);
    fireEvent.pointerMove(document.body, { clientX: 60, clientY: 12 });
    expect(trigger).toHaveAttribute("data-pointer-inside");

    // Leaving ends it, and the listeners go with it.
    fireEvent.pointerMove(document.body, OUTSIDE);
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
    fireEvent.pointerMove(document.body, INSIDE);
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
  });

  it("goes off on close when the pointer is elsewhere, and stops following", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    setState("open");
    fireEvent.pointerMove(document.body, INSIDE);
    // A click outside the trigger closes the menu.
    fireEvent.pointerDown(document.documentElement, OUTSIDE);
    setState("closed");
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
    fireEvent.pointerMove(document.body, INSIDE);
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
  });

  it("goes off on a keyboard close when the pointer never was over it", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    setState("open");
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
    setState("closed");
    fireEvent.pointerMove(document.body, INSIDE);
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
  });

  it("starts lit when the menu opens under the pointer", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    const matches = trigger.matches.bind(trigger);
    vi.spyOn(trigger, "matches").mockImplementation((selector) => selector === ":hover" || matches(selector));
    setState("open");
    expect(trigger).toHaveAttribute("data-pointer-inside");
  });

  it("lets go when the pointer leaves the page", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    setState("open");
    fireEvent.pointerMove(document.body, INSIDE);
    setState("closed");
    expect(trigger).toHaveAttribute("data-pointer-inside");
    fireEvent.pointerOut(document.body, { relatedTarget: null });
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
  });

  it("keeps no hover for a touch", () => {
    const { trigger, setState } = renderChevronTrigger("closed");
    setState("open");
    fireEvent.pointerMove(document.body, { ...INSIDE, pointerType: "touch" });
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
  });

  it("removes its listeners when the trigger goes away", () => {
    const { trigger, setState, unmount } = renderChevronTrigger("closed");
    setState("open");
    fireEvent.pointerMove(document.body, INSIDE);
    setState("closed");
    const removed = vi.spyOn(document, "removeEventListener");
    unmount();
    const types = removed.mock.calls.map(([type]) => type);
    expect(types).toEqual(expect.arrayContaining(["pointermove", "pointerdown", "pointerup", "pointerout"]));
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
    removed.mockRestore();
  });

  it("follows the pointer only in the top chrome", () => {
    const { trigger } = renderChevronTrigger("open", "clipperHeader");
    fireEvent.pointerMove(document.body, INSIDE);
    expect(trigger).not.toHaveAttribute("data-pointer-inside");
  });
});
