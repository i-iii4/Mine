import { fireEvent, render, screen } from "@testing-library/react";
import { setTheme as setTauriTheme } from "@tauri-apps/api/app";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeMenuButton } from "./ThemeMenuButton";

describe("ThemeMenuButton", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    vi.mocked(setTauriTheme).mockClear();
  });

  it("syncs the native AppKit theme with explicit and system theme choices", async () => {
    render(<ThemeMenuButton />);

    expect(setTauriTheme).toHaveBeenCalledWith(null);
    expect(document.documentElement).not.toHaveAttribute("data-theme");

    const trigger = screen.getByText("Settings").closest("[data-slot='dropdown-menu-trigger']");
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger!, { button: 0, ctrlKey: false });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(setTauriTheme).toHaveBeenLastCalledWith("light");

    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High Contrast" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "high-contrast");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(setTauriTheme).toHaveBeenLastCalledWith("dark");

    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "System" }));

    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(document.documentElement.style.colorScheme).toBe("");
    expect(setTauriTheme).toHaveBeenLastCalledWith(null);
  });

  it("exposes the Compact Detail top menu setting", () => {
    const onCompactDetailTopMenuChange = vi.fn();

    render(
      <ThemeMenuButton
        compactDetailTopMenuEnabled={false}
        onCompactDetailTopMenuChange={onCompactDetailTopMenuChange}
      />,
    );

    const trigger = screen.getByText("Settings").closest("[data-slot='dropdown-menu-trigger']");
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger!, { button: 0, ctrlKey: false });
    const item = screen.getByRole("menuitemcheckbox", {
      name: "Compact Detail top menu",
    });

    expect(item).toHaveAttribute("aria-checked", "false");
    fireEvent.click(item);

    expect(onCompactDetailTopMenuChange).toHaveBeenCalledWith(true);
  });

  it("exposes the bottom menu visibility setting", () => {
    const onBottomActionBarHiddenChange = vi.fn();

    render(
      <ThemeMenuButton
        bottomActionBarHidden={false}
        onBottomActionBarHiddenChange={onBottomActionBarHiddenChange}
      />,
    );

    const trigger = screen.getByText("Settings").closest("[data-slot='dropdown-menu-trigger']");
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger!, { button: 0, ctrlKey: false });

    const hideBottomMenuItem = screen.getByRole("menuitemcheckbox", {
      name: "Hide bottom menu",
    });

    expect(hideBottomMenuItem).toHaveAttribute("aria-checked", "false");
    fireEvent.click(hideBottomMenuItem);

    expect(onBottomActionBarHiddenChange).toHaveBeenCalledWith(true);
  });
});
