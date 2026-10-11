import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultSelect } from "./VaultSelect";

const CURRENT = "/Users/x/Spaces/Mine";
const OTHER = "/Users/x/Spaces/Journal";

function trigger() {
  return screen.getByRole("button", { name: /Switch space: Mine/ });
}

/** A pointer press and the click a browser sends after it. */
function pointerClick(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(target, { button: 0, pointerId: 1 });
  fireEvent.click(target, { detail: 1 });
}

async function openMenu() {
  pointerClick(trigger());
  await screen.findByRole("menuitem", { name: "Journal" });
}

function renderSelect(overrides: Partial<Parameters<typeof VaultSelect>[0]> = {}) {
  const props = {
    value: CURRENT,
    options: [CURRENT, OTHER],
    onChange: vi.fn(),
    onReveal: vi.fn(),
    onAddSpace: vi.fn(),
    ...overrides,
  };
  render(<VaultSelect {...props} />);
  return props;
}

describe("VaultSelect", () => {
  // The name is part of the header the overlay is dragged by (SPEC_CLIPPER.md,
  // Р10): the pointer opens the menu on the click, not on the press.
  it("opens on the click that follows a pointer press, not on the press", async () => {
    renderSelect();
    fireEvent.pointerDown(trigger(), { button: 0, pointerId: 1 });
    expect(screen.queryByRole("menuitem", { name: "Journal" })).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerUp(trigger(), { button: 0, pointerId: 1 });
    fireEvent.click(trigger(), { detail: 1 });
    expect(await screen.findByRole("menuitem", { name: "Journal" })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("data-clipper-drag-control");
  });

  it("shuts on a click of the name while open", async () => {
    renderSelect();
    await openMenu();
    pointerClick(trigger());
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Journal" })).not.toBeInTheDocument());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  // A long name dissolves as the app's space switcher and a tab's label do:
  // the tab's mask on the text alone, before the chevron, short of "…" and
  // the close button (SPEC_CLIPPER.md, Р10; DESIGN_SYSTEM.md, «Растворение
  // кромок», 11.10.2026). The layout itself is measured in the built
  // extension (clipper-worker-smoke.mjs); here the markup that gives it.
  it("dissolves a long name before its chevron, short of the header's buttons", () => {
    const long = "/Users/x/Spaces/Mine. Длинное название. Прям вот легендарное";
    const longName = "Mine. Длинное название. Прям вот легендарное";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === longName ? 500 : 0;
    });
    try {
      renderSelect({ value: long, options: [long, OTHER], onClose: vi.fn() });
      const name = screen.getByRole("button", { name: `Switch space: ${longName}` });
      const label = screen.getByText(longName);
      const row = name.closest<HTMLElement>("[data-clipper-space-row]")!;

      // The name gives up width in the row and clips what does not fit.
      expect(name.parentElement).toBe(row);
      expect(name).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
      // The text is a flex item of a flex plate that shrinks too; what does
      // not fit dissolves, no ellipsis. The whole name is in the hover hint.
      expect(label).toHaveAttribute("data-fade-text");
      expect(label).toHaveAttribute("data-overflow", "true");
      expect(label).toHaveClass("min-w-0", "overflow-hidden", "whitespace-nowrap");
      expect(label).not.toHaveClass("truncate");
      expect(name).toHaveAttribute("title", longName);
      expect(label.parentElement).toHaveClass("inline-flex", "min-w-0", "max-w-full");
      expect(label.parentElement).not.toHaveClass("shrink-0");
      // The chevron follows the plate and never shrinks.
      const chevron = name.querySelector("svg");
      expect(label.parentElement?.nextElementSibling).toBe(chevron);
      expect(chevron).toHaveClass("lucide-chevron-right", "shrink-0");

      // The buttons follow the name in the row's flow, not over it.
      const more = within(row).getByRole("button", { name: "More" });
      const close = within(row).getByRole("button", { name: "Close" });
      const buttons = more.parentElement!;
      expect(name.nextElementSibling).toBe(buttons);
      expect(buttons).toContainElement(close);
      expect(buttons).toHaveClass("ml-auto", "flex");
      expect(buttons.className).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/);
      expect(more).toHaveClass("shrink-0");

      // The mask is on the text alone: the button's hover plate, the chevron
      // and the header's buttons stay whole.
      expect(row.querySelectorAll("[data-fade-text]")).toHaveLength(1);
      expect(name).not.toHaveAttribute("data-fade-text");
      expect(label.parentElement).not.toHaveAttribute("data-fade-text");
      for (const part of [chevron!, more, close]) {
        expect(part.closest("[data-fade-text]")).toBeNull();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves a name that fits whole: no dissolve", () => {
    renderSelect();
    const label = within(trigger()).getByText("Mine");
    expect(label).toHaveAttribute("data-fade-text");
    expect(label).not.toHaveAttribute("data-overflow");
    expect(trigger()).toHaveAttribute("title", "Mine");
  });

  it.each(["Enter", " ", "ArrowDown"])("opens from the keyboard with %j, as before", async (key) => {
    renderSelect();
    fireEvent.keyDown(trigger(), { key });
    expect(await screen.findByRole("menuitem", { name: "Journal" })).toBeInTheDocument();
  });

  // DESIGN_SYSTEM.md, «Ширина» (11.10.2026): a list under a search field has
  // the search width, the desktop space switcher's.
  it("gives the space list the search width", async () => {
    renderSelect();
    await openMenu();
    expect(screen.getByRole("textbox", { name: "Search spaces" }).closest("[data-floating-menu]"))
      .toHaveAttribute("data-floating-menu", "search");
  });

  it("pins Reveal in Finder and Add space below the space list, desktop-style", async () => {
    renderSelect();
    await openMenu();

    for (const name of ["Reveal in Finder", "Add space"]) {
      const action = screen.getByRole("menuitem", { name });
      const slot = action.querySelector("[data-card-menu-icon-slot]");
      // Leading icon in the shared slot, exactly like the desktop switcher.
      expect(action.firstElementChild).toBe(slot);
      expect(slot?.querySelector("svg")).not.toBeNull();
    }
    // Space rows keep the same slot empty so the menu holds one text column.
    const row = screen.getByRole("menuitem", { name: "Journal" });
    expect(row.querySelector("[data-card-menu-icon-slot]")).not.toBeNull();
    expect(row.querySelector("[data-card-menu-icon-slot] svg")).toBeNull();
  });

  it("reveals the current space and closes the menu", async () => {
    const props = renderSelect();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));

    // The action targets the space the clipper is aimed at, not a row.
    expect(props.onReveal).toHaveBeenCalledWith(CURRENT);
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Reveal in Finder" })).not.toBeInTheDocument();
    });
  });

  it("hands Add space to the host folder chooser", async () => {
    const props = renderSelect();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Add space" }));

    expect(props.onAddSpace).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("reaches the pinned actions with arrow navigation from search", async () => {
    renderSelect();
    await openMenu();
    const search = screen.getByRole("textbox", { name: "Search spaces" });

    // One destination space, then Reveal, then Add.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Add space" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );
  });
});
