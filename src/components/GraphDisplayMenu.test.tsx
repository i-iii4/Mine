import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import {
  getGraphPreferences,
  GRAPH_PREFERENCES_STORAGE_KEY,
  reloadGraphPreferences,
  setGraphPreference,
} from "@/lib/graphPreferences";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { GraphDisplayMenu } from "./GraphDisplayMenu";

describe("The graph's Display panel (SPEC_GRAPH_VIEW.md, «Панель графа»)", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
    vi.mocked(emit).mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
  });

  async function openMenu() {
    const user = userEvent.setup();
    render(<GraphDisplayMenu />);
    await user.click(screen.getByRole("button", { name: "Display options" }));
    return user;
  }

  function switchedOn(): string[] {
    return within(screen.getByRole("group", { name: "Links" }))
      .getAllByRole("menuitemcheckbox")
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.textContent ?? "");
  }

  it("is the feed's Display button: the standard chrome icon with a menu aligned to its right edge", async () => {
    const user = userEvent.setup();
    render(<GraphDisplayMenu />);
    const trigger = screen.getByRole("button", { name: "Display options" });
    expect(trigger).toHaveAttribute("data-size", "chrome-icon");
    expect(trigger).toHaveAttribute("data-variant", "chrome");
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-floating-menu", "action");
    expect(menu).toHaveAttribute("data-align", "end");
    expect(menu).toHaveAttribute("data-display-panel", "graph");
  });

  // DESIGN_SYSTEM.md, «Ширина» (11.10.2026): the panel's width is its role's,
  // so the feed's three groups and the graph's one give the same panel.
  it("is as wide as the feed's panel, whatever each holds", async () => {
    const user = userEvent.setup();
    const shapes: Array<Record<string, string | null>> = [];
    for (const Panel of [FeedDisplayMenu, GraphDisplayMenu]) {
      const { unmount } = render(<Panel />);
      await user.click(screen.getByRole("button", { name: "Display options" }));
      const menu = screen.getByRole("menu");
      shapes.push({
        role: menu.getAttribute("data-floating-menu"),
        className: menu.className,
        width: menu.style.width,
        minWidth: menu.style.minWidth,
        maxWidth: menu.style.maxWidth,
      });
      unmount();
    }
    expect(shapes[0]).toEqual({
      role: "action",
      className: expect.not.stringMatching(/(?:^|\s)(?:min-|max-)?w-/),
      width: "",
      minWidth: "",
      maxWidth: "",
    });
    expect(shapes[1]).toEqual(shapes[0]);
  });

  it("offers one Links group with Wikilinks and Related notes, both on by default, and no switch for collections", async () => {
    await openMenu();
    const groups = screen.getAllByRole("group");
    expect(groups.map((group) =>
      document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
    )).toEqual(["Links"]);
    expect(within(groups[0]!).getAllByRole("menuitemcheckbox").map((item) => item.textContent))
      .toEqual(["Wikilinks", "Related notes"]);
    expect(switchedOn()).toEqual(["Wikilinks", "Related notes"]);
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
  });

  it("keeps every row on the menu's text column, the check in the leading icon slot", async () => {
    setGraphPreference("include_related_notes", false);
    await openMenu();
    for (const item of screen.getAllByRole("menuitemcheckbox")) {
      expect(item).toHaveClass("min-h-row", "px-plate", "text-base");
      expect(item).not.toHaveClass("pl-8");
      expect(item.firstElementChild).toHaveAttribute("data-card-menu-icon-slot");
    }
    const on = screen.getByRole("menuitemcheckbox", { name: "Wikilinks" });
    expect(on.querySelector("[data-card-menu-icon-slot] svg")).toHaveClass("size-[13px]");
    const off = screen.getByRole("menuitemcheckbox", { name: "Related notes" });
    expect(off.querySelector("[data-card-menu-icon-slot] svg")).toBeNull();
  });

  it("marks the stored switches when it opens", async () => {
    localStorage.setItem(
      GRAPH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ include_collections: false, include_wikilinks: false, include_related_notes: true }),
    );
    reloadGraphPreferences();
    await openMenu();
    expect(switchedOn()).toEqual(["Related notes"]);
  });

  it("applies each switch at once, remembers it, tells the other windows and stays open", async () => {
    const user = await openMenu();

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Wikilinks" }));
    expect(getGraphPreferences()).toEqual({ include_wikilinks: false, include_related_notes: true });
    expect(switchedOn()).toEqual(["Related notes"]);

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Related notes" }));
    expect(getGraphPreferences()).toEqual({ include_wikilinks: false, include_related_notes: false });
    expect(switchedOn()).toEqual([]);

    expect(JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY)!)).toEqual({
      include_wikilinks: false,
      include_related_notes: false,
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("settings-changed", expect.objectContaining({
      key: GRAPH_PREFERENCES_STORAGE_KEY,
    }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Wikilinks" }));
    expect(getGraphPreferences()).toEqual({ include_wikilinks: true, include_related_notes: false });
  });

  it("follows a change made in the Settings window while it is open", async () => {
    await openMenu();
    act(() => setGraphPreference("include_wikilinks", false));
    expect(switchedOn()).toEqual(["Related notes"]);
  });

  it("works from the keyboard and returns focus to the button on Escape", async () => {
    const user = userEvent.setup();
    render(<GraphDisplayMenu />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // The first switch has focus; the arrow moves to the second.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(getGraphPreferences()).toEqual({ include_wikilinks: true, include_related_notes: false });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Display options" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
