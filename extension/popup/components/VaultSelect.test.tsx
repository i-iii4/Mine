import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultSelect } from "./VaultSelect";

const CURRENT = "/Users/x/Spaces/Mine";
const OTHER = "/Users/x/Spaces/Journal";

async function openMenu() {
  // Radix opens its trigger on pointerdown, not on the synthesized click.
  const trigger = screen.getByRole("button", { name: /Switch space: Mine/ });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
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
