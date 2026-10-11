import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    // ChromePlate, so a long one dissolves before the chevron.
    const label = screen.getByText("Mine");
    expect(label).toHaveAttribute("data-fade-text");
    expect(label).toHaveClass("min-w-0", "overflow-hidden", "whitespace-nowrap");
    expect(label).not.toHaveClass("truncate");
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

// One surface, one way (DESIGN_SYSTEM.md, «Растворение кромок», 11.10.2026):
// the path of the top row and the clipper's header dissolve a name that does
// not fit, as a tab does, with the whole of it in the hover hint.
describe("MenuTextTrigger in a chrome strip with a name that does not fit", () => {
  const LONG = "Mine. Длинное название. Прям вот легендарное";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderNames(surface: "topChrome" | "clipperHeader") {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === LONG ? 500 : 0;
    });
    render(
      <>
        <MenuTextTrigger label="Mine" aria-label="Switch space: Mine" surface={surface} showChevron />
        <MenuTextTrigger label={LONG} aria-label={`Switch space: ${LONG}`} surface={surface} showChevron />
      </>,
    );
    return {
      short: screen.getByRole("button", { name: "Switch space: Mine" }),
      long: screen.getByRole("button", { name: `Switch space: ${LONG}` }),
    };
  }

  for (const surface of ["topChrome", "clipperHeader"] as const) {
    it(`dissolves only the name that does not fit (${surface})`, () => {
      const { short, long } = renderNames(surface);
      expect(within(short).getByText("Mine")).not.toHaveAttribute("data-overflow");
      expect(within(long).getByText(LONG)).toHaveAttribute("data-overflow", "true");
    });

    it(`keeps the mask on the text: the plate and the chevron stay whole (${surface})`, () => {
      const { long } = renderNames(surface);
      const masked = long.querySelectorAll("[data-fade-text]");
      expect(masked).toHaveLength(1);
      expect(masked[0]).toHaveTextContent(LONG);
      expect(masked[0]?.children).toHaveLength(0);
      expect(long).not.toHaveAttribute("data-fade-text");
      expect(masked[0]?.parentElement).not.toHaveAttribute("data-fade-text");
      const chevron = long.querySelector("svg");
      expect(chevron).not.toBeNull();
      expect(chevron?.closest("[data-fade-text]")).toBeNull();
    });

    it(`shows the whole name in the hover hint, as a tab does (${surface})`, () => {
      const { short, long } = renderNames(surface);
      expect(short).toHaveAttribute("title", "Mine");
      expect(long).toHaveAttribute("title", LONG);
    });
  }
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
