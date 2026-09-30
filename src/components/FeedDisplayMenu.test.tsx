import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { getFeedDisplay, reloadFeedDisplay } from "@/lib/feedDisplay";
import { applyDensity } from "@/lib/density";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe("Display panel (SPEC_FEED_DISPLAY.md, Д2, Д3)", () => {
  afterEach(() => {
    window.localStorage.clear();
    reloadFeedDisplay();
    applyDensity(32);
  });

  async function openPanel() {
    const user = userEvent.setup();
    render(<FeedDisplayMenu />);
    await user.click(screen.getByRole("button", { name: "Display options" }));
    return user;
  }

  it("offers Sort, Show and Spacing, in that order", async () => {
    await openPanel();
    const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Sort", "Show", "Spacing"]);
    for (const label of ["Newest first", "Oldest first", "Cards", "Mixed", "Media", "32", "24", "16"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("applies each choice at once and keeps the panel open", async () => {
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Oldest first" }));
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    fireEvent.click(screen.getByRole("button", { name: "24" }));

    expect(getFeedDisplay()).toEqual({ sort: "oldest", show: "media" });
    expect(window.localStorage.getItem("mine.spacing")).toBe("24");
    expect(screen.getByRole("button", { name: "Oldest first" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
  });

  it("closes with Escape", async () => {
    const user = await openPanel();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Sort" })).not.toBeInTheDocument();
  });
});
