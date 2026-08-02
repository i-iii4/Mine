import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { setTheme as setTauriTheme } from "@tauri-apps/api/app";
import { AppearanceSection } from "./AppearanceSection";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

describe("AppearanceSection", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-design");
    vi.mocked(emit).mockClear();
    vi.mocked(setTauriTheme).mockClear();
  });

  it("applies the chosen theme and broadcasts the change", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(setTauriTheme).toHaveBeenLastCalledWith("dark");
    expect(emit).toHaveBeenCalledWith("settings-changed", { key: "theme" });
  });

  it("switches the design variant independently of the theme", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("button", { name: "Alt" }));

    expect(localStorage.getItem("mine.design")).toBe("alt");
    expect(document.documentElement.getAttribute("data-design")).toBe("alt");
    expect(emit).toHaveBeenCalledWith("settings-changed", { key: "mine.design" });
    // The theme control is untouched: light/dark/system combine with alt.
    expect(localStorage.getItem("theme")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-design")).toBe("alt");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("persists the Compact Detail top menu flag and broadcasts its key", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Compact Detail top menu" }));

    expect(localStorage.getItem("mine.compactDetailTopMenu")).toBe("true");
    expect(emit).toHaveBeenCalledWith("settings-changed", {
      key: "mine.compactDetailTopMenu",
    });
  });

  it("persists the bottom menu visibility flag and broadcasts its key", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Hide bottom menu" }));

    expect(localStorage.getItem("mine.bottomActionBarHidden")).toBe("true");
    expect(emit).toHaveBeenCalledWith("settings-changed", {
      key: "mine.bottomActionBarHidden",
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Hide bottom menu" }));
    expect(localStorage.getItem("mine.bottomActionBarHidden")).toBe("false");
  });

  it("persists the scroll edge fade flag and broadcasts its key", () => {
    render(<AppearanceSection />);

    const checkbox = screen.getByRole("checkbox", { name: "Fade content under the chrome" });
    // Off by default: a fresh install keeps the existing hard content edge.
    expect(checkbox).toHaveAttribute("data-state", "unchecked");

    fireEvent.click(checkbox);
    expect(localStorage.getItem("mine.scrollEdgeFade")).toBe("true");
    expect(emit).toHaveBeenCalledWith("settings-changed", {
      key: "mine.scrollEdgeFade",
    });

    fireEvent.click(checkbox);
    expect(localStorage.getItem("mine.scrollEdgeFade")).toBe("false");
  });

  it("reflects stored values on mount", () => {
    localStorage.setItem("theme", "light");
    localStorage.setItem("mine.compactDetailTopMenu", "true");
    localStorage.setItem("mine.scrollEdgeFade", "true");

    render(<AppearanceSection />);

    expect(
      screen.getByRole("checkbox", { name: "Fade content under the chrome" }),
    ).toHaveAttribute("data-state", "checked");

    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("checkbox", { name: "Compact Detail top menu" }),
    ).toHaveAttribute("data-state", "checked");
  });
});
