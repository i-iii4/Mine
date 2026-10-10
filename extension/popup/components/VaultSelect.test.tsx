import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it.each(["Enter", " ", "ArrowDown"])("opens from the keyboard with %j, as before", async (key) => {
    renderSelect();
    fireEvent.keyDown(trigger(), { key });
    expect(await screen.findByRole("menuitem", { name: "Journal" })).toBeInTheDocument();
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
