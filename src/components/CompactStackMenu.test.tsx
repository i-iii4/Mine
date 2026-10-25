import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import {
  COMPACT_STACK_EDGE_STORAGE_KEY,
  COMPACT_TABLE_POSTPONED,
  LIST_SPACING_STORAGE_KEY,
  LIST_STYLE_STORAGE_KEY,
  SIDEBAR_STYLE_STORAGE_KEY,
  getListSpacing,
  getListStyle,
  getSidebarStyle,
  reloadCompactStackEdge,
  reloadListSpacing,
  reloadListStyle,
  reloadSidebarStyle,
} from "@/lib/compactStack";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CompactStackMenu } from "./CompactStackMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const KEYS = [
  SIDEBAR_STYLE_STORAGE_KEY,
  COMPACT_STACK_EDGE_STORAGE_KEY,
  LIST_SPACING_STORAGE_KEY,
  LIST_STYLE_STORAGE_KEY,
];

function reloadAll() {
  reloadSidebarStyle();
  reloadCompactStackEdge();
  reloadListSpacing();
  reloadListStyle();
}

async function openMenu() {
  const user = userEvent.setup();
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <CompactStackMenu />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  return user;
}

/// TRIAL (PLAN 50.38): the sidebar's groups in the Display panel. The narrow
/// table is postponed (user's decision of 23.10.2026): its groups are hidden
/// and below the compact threshold the sidebar is always the List.
describe("CompactStackMenu", () => {
  afterEach(() => {
    for (const key of KEYS) localStorage.removeItem(key);
    act(() => reloadAll());
  });

  it("offers the List's captioned groups, today's choice checked in each", async () => {
    await openMenu();
    const groups = [
      ["List spacing", "Tight", "Table"],
      ["List style", "Plain", "Contents"],
    ] as const;
    for (const [caption, chosen, other] of groups) {
      const group = screen.getByRole("group", { name: caption });
      expect(group).toHaveAttribute("data-display-trial");
      expect(within(group).getByRole("menuitemradio", { name: chosen })).toHaveAttribute("aria-checked", "true");
      expect(within(group).getByRole("menuitemradio", { name: other })).toHaveAttribute("aria-checked", "false");
    }
  });

  it("hides the narrow table's groups while it is postponed, and keeps the List", async () => {
    expect(COMPACT_TABLE_POSTPONED).toBe(true);
    await openMenu();
    expect(screen.queryByRole("group", { name: "Sidebar style" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Compact stack edge" })).toBeNull();
    // A Table stored before the postponement still shows the List.
    localStorage.setItem(SIDEBAR_STYLE_STORAGE_KEY, "table");
    act(() => reloadSidebarStyle());
    expect(getSidebarStyle()).toBe("list");
    expect(document.documentElement.hasAttribute("data-sidebar-list")).toBe(true);
  });

  it("applies each choice to the root, keeps the panel open and tells the other tabs and windows", async () => {
    const user = await openMenu();
    const choices = [
      ["Table", LIST_SPACING_STORAGE_KEY, "data-sidebar-list-roomy", getListSpacing, "table"],
      ["Contents", LIST_STYLE_STORAGE_KEY, "data-sidebar-list-toc", getListStyle, "contents"],
    ] as const;
    for (const [label, key, flag, get, value] of choices) {
      await user.click(screen.getByRole("menuitemradio", { name: label }));
      expect(get()).toBe(value);
      expect(localStorage.getItem(key)).toBe(value);
      expect(document.documentElement.hasAttribute(flag)).toBe(true);
      expect(screen.getByRole("menuitemradio", { name: label })).toHaveAttribute("aria-checked", "true");
      expect(vi.mocked(emit)).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key }));
    }
  });

  it("shows the choices made elsewhere", async () => {
    localStorage.setItem(LIST_SPACING_STORAGE_KEY, "table");
    localStorage.setItem(LIST_STYLE_STORAGE_KEY, "contents");
    reloadAll();
    await openMenu();
    expect(screen.getByRole("menuitemradio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Contents" })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.hasAttribute("data-sidebar-list-roomy")).toBe(true);
    expect(document.documentElement.hasAttribute("data-sidebar-list-toc")).toBe(true);
  });
});
