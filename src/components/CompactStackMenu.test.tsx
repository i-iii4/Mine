import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import {
  COMPACT_STACK_EDGE_STORAGE_KEY,
  COMPACT_TABLE_POSTPONED,
  SIDEBAR_STYLE_STORAGE_KEY,
  getCompactStackEdge,
  getSidebarStyle,
  reloadCompactStackEdge,
  reloadSidebarStyle,
} from "@/lib/compactStack";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CompactStackMenu } from "./CompactStackMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const KEYS = [SIDEBAR_STYLE_STORAGE_KEY, COMPACT_STACK_EDGE_STORAGE_KEY];

function reloadAll() {
  reloadSidebarStyle();
  reloadCompactStackEdge();
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

/// TRIAL (PLAN 50.38): the narrow table's groups, postponed with it (user's
/// decision of 23.10.2026). The Display panel does not show them while it is
/// postponed (FeedDisplayMenu.test.tsx); List spacing and List style are
/// fixed, Tight and Contents, and have no group (user's decision of 15.11.2026).
describe("CompactStackMenu", () => {
  afterEach(() => {
    for (const key of KEYS) localStorage.removeItem(key);
    act(() => reloadAll());
  });

  it("holds only the narrow table's groups, today's choice checked in each", async () => {
    await openMenu();
    const groups = [
      ["Sidebar style", "Table", "List"],
      ["Compact stack edge", "Shadow", "Ring"],
    ] as const;
    for (const [caption, chosen, other] of groups) {
      const group = screen.getByRole("group", { name: caption });
      expect(group).toHaveAttribute("data-display-trial");
      expect(within(group).getByRole("menuitemradio", { name: chosen })).toHaveAttribute("aria-checked", "true");
      expect(within(group).getByRole("menuitemradio", { name: other })).toHaveAttribute("aria-checked", "false");
    }
    expect(screen.getAllByRole("group")).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "List spacing" })).toBeNull();
    expect(screen.queryByRole("group", { name: "List style" })).toBeNull();
  });

  it("keeps the List while the narrow table is postponed, whatever was stored", () => {
    expect(COMPACT_TABLE_POSTPONED).toBe(true);
    localStorage.setItem(SIDEBAR_STYLE_STORAGE_KEY, "table");
    act(() => reloadSidebarStyle());
    expect(getSidebarStyle()).toBe("list");
    expect(document.documentElement.hasAttribute("data-sidebar-list")).toBe(true);
  });

  it("applies the stack's edge to the root and tells the other tabs and windows", async () => {
    const user = await openMenu();
    await user.click(screen.getByRole("menuitemradio", { name: "Ring" }));
    expect(getCompactStackEdge()).toBe("ring");
    expect(localStorage.getItem(COMPACT_STACK_EDGE_STORAGE_KEY)).toBe("ring");
    expect(document.documentElement.hasAttribute("data-sidebar-stack-ring")).toBe(true);
    expect(screen.getByRole("menuitemradio", { name: "Ring" })).toHaveAttribute("aria-checked", "true");
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ key: COMPACT_STACK_EDGE_STORAGE_KEY }),
    );
  });
});
