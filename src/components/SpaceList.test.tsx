// The list of spaces (SPEC_MENU_WINDOW.md, МО27, Г1): what its rows, their
// buttons and its keys ask of the page the menu came from. The space
// switcher's own tests hold the rest of its behaviour (VaultSwitcher.test.tsx).

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MenuSpace } from "@/types";
import { SpaceList, type SpaceListProps } from "./SpaceList";

const ARCHIVE: MenuSpace = { path: "/spaces/Archive", name: "Archive", tab: true };
const OLD: MenuSpace = { path: "/spaces/Old", name: "Old", tab: false };
const GONE: MenuSpace = { path: "/spaces/Gone", name: "Gone", tab: false };

function renderList(over: Partial<SpaceListProps> = {}) {
  const handlers = {
    onSwitch: vi.fn(),
    onReveal: vi.fn(),
    onRequestForget: vi.fn(),
    onRevealCurrent: vi.fn(),
    onAddSpace: vi.fn(),
  };
  const onOpenChange = vi.fn();
  render(
    <DropdownMenu open onOpenChange={onOpenChange}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent widthRole="search" className="overflow-hidden p-0">
        <SpaceList spaces={[ARCHIVE, OLD]} unavailable={[GONE]} tabs open {...handlers} {...over} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return { ...handlers, onOpenChange, field: screen.getByPlaceholderText("Search spaces...") as HTMLInputElement };
}

const row = (name: string) => screen.getByRole("menuitem", { name });

describe("SpaceList", () => {
  it("lists the spaces in their order, then the ones whose folder is gone, then the pinned actions", () => {
    renderList();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Archive", "Old", "Reveal in Finder", "Add space"]);
    expect(document.querySelector("[data-vault-switcher-unavailable]")?.textContent).toContain("Gone");
    expect(document.querySelector("[data-vault-switcher-unavailable]")?.textContent).toContain("Unavailable");
  });

  it("goes to a space in this tab on a plain choice, and in a new tab with ⌘", async () => {
    const { onSwitch } = renderList();
    fireEvent.click(row("Archive"));
    await waitFor(() => expect(onSwitch).toHaveBeenLastCalledWith(ARCHIVE.path, false));
    fireEvent.click(row("Archive"), { metaKey: true });
    await waitFor(() => expect(onSwitch).toHaveBeenLastCalledWith(ARCHIVE.path, true));
    expect(onSwitch).toHaveBeenCalledTimes(2);
  });

  it("opens no tab for a space with no identity, and has no tabs on a page that opens none", async () => {
    const { onSwitch } = renderList();
    fireEvent.click(row("Old"), { metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open Old in New Tab" })).toBeDisabled();
  });

  it("switches on ⌘ with a choice where the page opens no tabs", async () => {
    const { onSwitch } = renderList({ tabs: false });
    expect(screen.queryByRole("button", { name: "Open Archive in New Tab" })).toBeNull();
    fireEvent.click(row("Archive"), { metaKey: true });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith(ARCHIVE.path, false));
  });

  it("asks for what a row's buttons do, and leaves the row itself alone", () => {
    const { onSwitch, onReveal, onRequestForget } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Open Archive in New Tab" }));
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith(ARCHIVE.path, true);
    fireEvent.click(screen.getByRole("button", { name: "Reveal Archive in Finder" }));
    expect(onReveal).toHaveBeenCalledExactlyOnceWith(ARCHIVE.path);
    fireEvent.click(screen.getByRole("button", { name: "Remove Old from the list" }));
    expect(onRequestForget).toHaveBeenCalledExactlyOnceWith(OLD.path);
    fireEvent.click(screen.getByRole("button", { name: "Forget Gone" }));
    expect(onRequestForget).toHaveBeenLastCalledWith(GONE.path);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("asks for the pinned actions", async () => {
    const { onRevealCurrent, onAddSpace } = renderList();
    fireEvent.click(row("Reveal in Finder"));
    await waitFor(() => expect(onRevealCurrent).toHaveBeenCalledTimes(1));
    fireEvent.click(row("Add space"));
    await waitFor(() => expect(onAddSpace).toHaveBeenCalledTimes(1));
  });

  it("filters by name and by folder as the query is typed, the gone spaces too", () => {
    const { field } = renderList();
    fireEvent.change(field, { target: { value: "arch" } });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Archive", "Reveal in Finder", "Add space"]);
    expect(document.querySelector("[data-vault-switcher-unavailable]")).toBeNull();
    fireEvent.change(field, { target: { value: "gone" } });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Reveal in Finder", "Add space"]);
    expect(document.querySelector("[data-vault-switcher-unavailable]")?.textContent).toContain("Gone");
  });

  it("clears a typed query on the first Escape and leaves the next one to the menu above", () => {
    const { field, onOpenChange } = renderList();
    fireEvent.change(field, { target: { value: "arch" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moves the lit row with the arrows and chooses it with Enter, the caret staying in the field", async () => {
    const { field, onSwitch } = renderList();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(row("Old").getAttribute("aria-selected")).toBe("true");
    expect(field.getAttribute("aria-activedescendant")).toBe(row("Old").id);
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith(OLD.path, false));
  });
});
