import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { getFeedDisplay, reloadFeedDisplay } from "@/lib/feedDisplay";
import { applyDensity } from "@/lib/density";

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

  it("is the standard chrome icon button with a command menu aligned to its right edge", async () => {
    const user = userEvent.setup();
    render(<FeedDisplayMenu />);
    const trigger = screen.getByRole("button", { name: "Display options" });
    expect(trigger).toHaveAttribute("data-size", "chrome-icon");
    expect(trigger).toHaveAttribute("data-variant", "chrome");
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-floating-menu-width", "command");
    expect(menu).toHaveAttribute("data-align", "end");
  });

  it("offers Sort, Show and Spacing as radio groups, each marking the current choice", async () => {
    await openMenu();
    const groups = screen.getAllByRole("group");
    // Each group is named by the caption above it, in this order (Д2); media
    // placement is no longer a choice (Д19).
    expect(groups.map((group) =>
      document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
    )).toEqual(["Sort", "Show", "Spacing"]);
    expect(groups.map((group) => group.textContent)).toEqual([
      "Newest firstOldest first",
      "CardsMedia",
      "322416",
    ]);
    expect(checkedIn("Sort")).toEqual(["Newest first"]);
    expect(checkedIn("Show")).toEqual(["Cards"]);
    expect(checkedIn("Spacing")).toEqual(["32"]);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("marks the stored presentation when it opens (Д18)", async () => {
    window.localStorage.setItem("mine.feed.show", "media");
    reloadFeedDisplay();
    await openMenu();
    expect(checkedIn("Show")).toEqual(["Media"]);
  });

  it("keeps every row on the menu's text column, the check in the leading icon slot", async () => {
    await openMenu();
    for (const item of screen.getAllByRole("menuitemradio")) {
      expect(item).toHaveClass("px-2", "py-1.5", "text-base");
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
    await user.click(screen.getByRole("menuitemradio", { name: "Media" }));
    await user.click(screen.getByRole("menuitemradio", { name: "24" }));

    expect(getFeedDisplay()).toEqual({ sort: "oldest", show: "media" });
    expect(window.localStorage.getItem("mine.feed.sort")).toBe("oldest");
    expect(window.localStorage.getItem("mine.feed.show")).toBe("media");
    expect(window.localStorage.getItem("mine.spacing")).toBe("24");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(checkedIn("Sort")).toEqual(["Oldest first"]);
    expect(checkedIn("Show")).toEqual(["Media"]);
    expect(checkedIn("Spacing")).toEqual(["24"]);
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
});
