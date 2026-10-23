import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import {
  COMPACT_STACK_EDGE_STORAGE_KEY,
  COMPACT_STACK_STORAGE_KEY,
  SIDEBAR_STYLE_STORAGE_KEY,
  THUMB_CORNERS_STORAGE_KEY,
  getCompactStack,
  getCompactStackEdge,
  getSidebarStyle,
  getThumbCorners,
  reloadCompactStack,
  reloadCompactStackEdge,
  reloadSidebarStyle,
  reloadThumbCorners,
} from "@/lib/compactStack";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CompactStackMenu } from "./CompactStackMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const KEYS = [
  SIDEBAR_STYLE_STORAGE_KEY,
  COMPACT_STACK_STORAGE_KEY,
  COMPACT_STACK_EDGE_STORAGE_KEY,
  THUMB_CORNERS_STORAGE_KEY,
];

function reloadAll() {
  reloadSidebarStyle();
  reloadCompactStack();
  reloadCompactStackEdge();
  reloadThumbCorners();
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

/// TRIAL (PLAN 50.38): the compact sidebar's groups in the Display panel.
describe("CompactStackMenu", () => {
  afterEach(() => {
    for (const key of KEYS) localStorage.removeItem(key);
    act(() => reloadAll());
  });

  it("offers four captioned groups, today's choice checked in each", async () => {
    await openMenu();
    const groups = [
      ["Sidebar style", "Table", "List"],
      ["Compact stack size", "Standard", "Large"],
      ["Compact stack edge", "Shadow", "Ring"],
      ["Thumbnail corners", "Square", "Rounded"],
    ] as const;
    for (const [caption, chosen, other] of groups) {
      const group = screen.getByRole("group", { name: caption });
      expect(group).toHaveAttribute("data-display-trial");
      expect(within(group).getByRole("menuitemradio", { name: chosen })).toHaveAttribute("aria-checked", "true");
      expect(within(group).getByRole("menuitemradio", { name: other })).toHaveAttribute("aria-checked", "false");
    }
  });

  it("applies each choice to the root, keeps the panel open and tells the other tabs and windows", async () => {
    const user = await openMenu();
    const choices = [
      ["List", SIDEBAR_STYLE_STORAGE_KEY, "data-sidebar-list", getSidebarStyle, "list"],
      ["Large", COMPACT_STACK_STORAGE_KEY, "data-sidebar-stack-large", getCompactStack, "large"],
      ["Ring", COMPACT_STACK_EDGE_STORAGE_KEY, "data-sidebar-stack-ring", getCompactStackEdge, "ring"],
      ["Rounded", THUMB_CORNERS_STORAGE_KEY, "data-sidebar-thumbs-rounded", getThumbCorners, "rounded"],
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
    localStorage.setItem(SIDEBAR_STYLE_STORAGE_KEY, "list");
    localStorage.setItem(COMPACT_STACK_EDGE_STORAGE_KEY, "ring");
    reloadAll();
    await openMenu();
    expect(screen.getByRole("menuitemradio", { name: "List" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Ring" })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.hasAttribute("data-sidebar-stack-ring")).toBe(true);
  });
});
