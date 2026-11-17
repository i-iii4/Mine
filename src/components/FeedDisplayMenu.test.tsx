import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DisplayMenu } from "./DisplayMenu";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { getFeedDisplay, reloadFeedDisplay } from "@/lib/feedDisplay";
import { applyDensity } from "@/lib/density";
import { emit } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe("Display menu (SPEC_FEED_DISPLAY.md, Д1 to Д3)", () => {
  afterEach(() => {
    window.localStorage.clear();
    reloadFeedDisplay();
    applyDensity(32);
  });

  async function openMenu() {
    const user = userEvent.setup();
    render(<FeedDisplayMenu />);
    await user.click(screen.getByRole("button", { name: "Display options" }));
    return user;
  }

  function checkedIn(group: string): string[] {
    return within(screen.getByRole("group", { name: group }))
      .getAllByRole("menuitemradio")
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.textContent ?? "");
  }

  it("is the standard chrome icon button with a command menu opening right and down off it (SPEC_MENU_WINDOW.md, МО7)", async () => {
    const user = userEvent.setup();
    render(<FeedDisplayMenu />);
    const trigger = screen.getByRole("button", { name: "Display options" });
    expect(trigger).toHaveAttribute("data-size", "chrome-icon");
    expect(trigger).toHaveAttribute("data-variant", "chrome");
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-floating-menu", "action");
    expect(menu).toHaveAttribute("data-align", "start");
  });

  it("offers Sort, Show and Spacing as radio groups, each marking the current choice", async () => {
    await openMenu();
    // Each group is named by the caption above it, in this order (Д2); media
    // placement is no longer a choice (Д19). The open card's view follows
    // the feed's groups and ends the panel (SPEC_CARD_PEEK.md, О1).
    const all = screen.getAllByRole("group");
    expect(all.map((group) =>
      document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
    )).toEqual(["Sort", "Show", "Spacing", "Element view"]);
    const groups = all.slice(0, 3);
    expect(groups.map((group) => group.textContent)).toEqual([
      "Newest firstOldest first",
      "Media and TextText on HoverMedia Only",
      // 8 and 2 after 32, 24 and 16 (user's decision of 15.11.2026).
      "32241682",
    ]);
    expect(checkedIn("Sort")).toEqual(["Newest first"]);
    expect(checkedIn("Show")).toEqual(["Media and Text"]);
    expect(checkedIn("Spacing")).toEqual(["32"]);
    // Two between the feed's groups and one before the open card's view,
    // which ends the panel.
    expect(screen.getAllByRole("separator")).toHaveLength(3);
    expect(screen.getByRole("menu").lastElementChild).toBe(all[3]);
  });

  it.each(["feed", "graph"] as const)(
    "holds no choice of the sidebar's columns, List spacing or List style in the %s panel (SPEC_FRONTEND.md, «Столбцы и вид List»)",
    async (panel) => {
      // Choices stored before the user's decision of 15.11.2026 change nothing on the root.
      window.localStorage.setItem("mine.sidebar.columns", JSON.stringify({ order: ["count", "previews", "name"], hidden: ["previews"] }));
      window.localStorage.setItem("mine.sidebar.listSpacing", "table");
      window.localStorage.setItem("mine.sidebar.listStyle", "plain");
      const user = userEvent.setup();
      render(<DisplayMenu panel={panel} view={{ groups: [], largest: [], apply: () => false }} />);
      await user.click(screen.getByRole("button", { name: "Display options" }));
      for (const caption of ["Sidebar columns", "List spacing", "List style", "Sidebar style", "Compact stack edge"]) {
        expect(screen.queryByRole("group", { name: caption })).toBeNull();
      }
      expect(screen.queryByText("Sidebar columns")).toBeNull();
      expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
      // What the panel holds of its own: the open card's view alone.
      expect(screen.queryByRole("separator")).toBeNull();
      expect(screen.getAllByRole("group").map((group) =>
        document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
      )).toEqual(["Element view"]);
      const root = document.documentElement;
      for (const attribute of root.getAttributeNames()) {
        expect(attribute).not.toMatch(/^data-sidebar-(list-roomy|list-toc|hide-|stack-left)/);
      }
      expect(root.getAttribute("style") ?? "").not.toMatch(/--sidebar-(name-left|guide-|meta-right|(name|previews|count)-(order|lead))/);
    },
  );

  it.each([
    ["cards", "Media and Text"],
    ["media", "Text on Hover"],
    ["media-only", "Media Only"],
  ])("marks the stored presentation %s by its label when it opens (Д10, Д18)", async (stored, label) => {
    window.localStorage.setItem("mine.feed.show", stored);
    reloadFeedDisplay();
    await openMenu();
    expect(checkedIn("Show")).toEqual([label]);
  });

  it("stores Media Only under its own value (Д31)", async () => {
    const user = await openMenu();
    await user.click(screen.getByRole("menuitemradio", { name: "Media Only" }));
    expect(getFeedDisplay().show).toBe("media-only");
    expect(window.localStorage.getItem("mine.feed.show")).toBe("media-only");
    expect(checkedIn("Show")).toEqual(["Media Only"]);
  });

  it("writes the presentations' labels in one place, the menu's list (Д10)", () => {
    const source = readFileSync("src/components/FeedDisplayMenu.tsx", "utf8");
    for (const label of ["Media and Text", "Text on Hover", "Media Only"]) {
      expect(source.split(`"${label}"`)).toHaveLength(2);
    }
  });

  it("keeps every row on the menu's text column, the check in the leading icon slot", async () => {
    await openMenu();
    for (const item of screen.getAllByRole("menuitemradio")) {
      expect(item).toHaveClass("min-h-row", "px-plate", "text-base");
      expect(item).not.toHaveClass("pl-8");
      expect(item.firstElementChild).toHaveAttribute("data-card-menu-icon-slot");
    }
    const newest = screen.getByRole("menuitemradio", { name: "Newest first" });
    expect(newest.querySelector("[data-card-menu-icon-slot] svg")).toHaveClass("size-[13px]");
    const oldest = screen.getByRole("menuitemradio", { name: "Oldest first" });
    expect(oldest.querySelector("[data-card-menu-icon-slot] svg")).toBeNull();
  });

  it("applies each choice at once and stays open", async () => {
    const user = await openMenu();
    await user.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Text on Hover" }));
    await user.click(screen.getByRole("menuitemradio", { name: "24" }));

    expect(getFeedDisplay()).toEqual({ sort: "oldest", show: "media" });
    expect(window.localStorage.getItem("mine.feed.sort")).toBe("oldest");
    expect(window.localStorage.getItem("mine.feed.show")).toBe("media");
    expect(window.localStorage.getItem("mine.spacing")).toBe("24");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(checkedIn("Sort")).toEqual(["Oldest first"]);
    expect(checkedIn("Show")).toEqual(["Text on Hover"]);
    expect(checkedIn("Spacing")).toEqual(["24"]);
  });

  it.each(["8", "2"])("applies Spacing %s like the other steps", async (step) => {
    const user = await openMenu();
    await user.click(screen.getByRole("menuitemradio", { name: step }));
    expect(window.localStorage.getItem("mine.spacing")).toBe(step);
    expect(document.documentElement.style.getPropertyValue("--edge-rhythm")).toBe(`${step}px`);
    expect(checkedIn("Spacing")).toEqual([step]);
    expect(vi.mocked(emit)).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: "mine.spacing" }));
  });

  it("works from the keyboard and returns focus to the button on Escape", async () => {
    const user = userEvent.setup();
    render(<FeedDisplayMenu />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(getFeedDisplay().sort).toBe("oldest");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Display options" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes on an outside click", async () => {
    const user = await openMenu();
    // Radix disables body pointer events while its modal menu is open;
    // an outside click lands on the document root instead.
    await user.click(document.documentElement);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /// SPEC_DEEP_AUDIT.md, Е6.7: a choice of Sort or Show reaches the other
  /// tabs and windows, with its value, as Spacing does.
  it("tells the other tabs the Sort and the Show chosen", async () => {
    const user = await openMenu();
    vi.mocked(emit).mockClear();

    await user.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Text on Hover" }));

    expect(emit).toHaveBeenCalledWith("settings-changed", { key: "mine.feed.sort", value: "oldest" });
    expect(emit).toHaveBeenCalledWith("settings-changed", { key: "mine.feed.show", value: "media" });
  });
});
