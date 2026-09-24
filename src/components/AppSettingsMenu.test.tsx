import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSettingsMenu } from "./AppSettingsMenu";

const sections = [
  ["Appearance", "appearance"], ["Shortcuts", "shortcuts"],
  ["Graph", "graph"], ["Spaces", "spaces"], ["New files", "layout"],
  ["Extension", "clipper"], ["Orphans", "orphans"], ["Design system", "design-system"],
];

describe("AppSettingsMenu", () => {
  it.each(sections)("opens the %s settings section", async (label, id) => {
    const user = userEvent.setup();
    const onSelectSection = vi.fn();
    render(<AppSettingsMenu onSelectSection={onSelectSection} />);
    const trigger = screen.getByRole("button", { name: "Mine settings" });
    expect(trigger).not.toHaveAttribute("data-tauri-drag-region");
    expect(trigger.querySelector("img")).toBeNull();
    const logo = trigger.querySelector("svg");
    expect(logo).toHaveAttribute("fill", "currentColor");
    expect(logo).not.toHaveClass("text-foreground");
    expect(logo).toHaveAttribute("viewBox", "-100 -250 1000 1000");
    expect(logo?.querySelector("rect, image, text")).toBeNull();
    await user.click(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(sections.map(([name]) => name));
    await user.click(screen.getByRole("menuitem", { name: label }));
    expect(onSelectSection).toHaveBeenCalledExactlyOnceWith(id);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).not.toHaveFocus());
    expect(trigger).not.toHaveAttribute("data-top-chrome-keyboard-focus");
  });

  it("opens and dismisses with the keyboard, restoring focus", async () => {
    const user = userEvent.setup();
    const onSelectSection = vi.fn();
    render(<AppSettingsMenu onSelectSection={onSelectSection} />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    const trigger = screen.getByRole("button", { name: "Mine settings" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("data-top-chrome-keyboard-focus", "true");
    expect(onSelectSection).not.toHaveBeenCalled();
  });

  it("selects a section with arrow keys and Enter", async () => {
    const user = userEvent.setup();
    const onSelectSection = vi.fn();
    render(<AppSettingsMenu onSelectSection={onSelectSection} />);
    await user.tab();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(onSelectSection).toHaveBeenCalledExactlyOnceWith("shortcuts");
  });

  it("dismisses on outside click without selecting a section", async () => {
    const user = userEvent.setup();
    const onSelectSection = vi.fn();
    render(<AppSettingsMenu onSelectSection={onSelectSection} />);
    await user.click(screen.getByRole("button", { name: "Mine settings" }));
    // Radix disables body pointer events while its modal menu is open;
    // an outside click lands on the document root instead.
    await user.click(document.documentElement);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onSelectSection).not.toHaveBeenCalled();
  });
});
