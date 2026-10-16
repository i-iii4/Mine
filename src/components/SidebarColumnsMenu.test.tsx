import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  SIDEBAR_COLUMNS_STORAGE_KEY,
  getSidebarColumnLayout,
  reloadSidebarColumnLayout,
} from "@/lib/sidebarColumnLayout";
import { DisplayMenu } from "./DisplayMenu";
import { SidebarColumnsMenu } from "./SidebarColumnsMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

/// TRIAL (PLAN 47.6): «Sidebar columns» in the Display panel.
describe("SidebarColumnsMenu", () => {
  afterEach(() => {
    localStorage.removeItem(SIDEBAR_COLUMNS_STORAGE_KEY);
    reloadSidebarColumnLayout();
  });

  async function open() {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Display options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SidebarColumnsMenu />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Display options" }));
    return user;
  }

  it("lists the row's columns in today's order, all shown, each movable", async () => {
    await open();
    expect(screen.getByRole("group", { name: "Sidebar columns" })).toBeInTheDocument();
    const items = screen.getAllByRole("menuitemcheckbox");
    expect(items.map((item) => item.textContent)).toEqual(["Name", "Previews", "Count"]);
    expect(items.every((item) => item.getAttribute("aria-checked") === "true")).toBe(true);
    for (const label of ["Name", "Previews", "Count"]) {
      expect(screen.getByRole("button", { name: `Move ${label}` })).toBeInTheDocument();
    }
  });

  it("hides and shows a column, keeps the panel open and tells the other tabs", async () => {
    const user = await open();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Previews" }));
    expect(getSidebarColumnLayout().hidden).toEqual(["previews"]);
    expect(document.documentElement.hasAttribute("data-sidebar-hide-previews")).toBe(true);
    expect(screen.getByRole("menuitemcheckbox", { name: "Previews" })).toHaveAttribute("aria-checked", "false");
    expect(vi.mocked(emit)).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: SIDEBAR_COLUMNS_STORAGE_KEY }));

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Previews" }));
    expect(getSidebarColumnLayout().hidden).toEqual([]);
  });

  it("stands in the Display panel of the feed and of the graph", async () => {
    for (const panel of ["feed", "graph"] as const) {
      const user = userEvent.setup();
      const { unmount } = render(<DisplayMenu panel={panel}>{null}</DisplayMenu>);
      await user.click(screen.getByRole("button", { name: "Display options" }));
      expect(screen.getByRole("group", { name: "Sidebar columns" })).toBeInTheDocument();
      unmount();
    }
  });

  it("keeps the last shown column shown", async () => {
    const user = await open();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Name" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Previews" }));
    const count = screen.getByRole("menuitemcheckbox", { name: "Count" });
    expect(count).toHaveAttribute("aria-disabled", "true");
    expect(getSidebarColumnLayout().hidden).toEqual(["name", "previews"]);
  });
});
