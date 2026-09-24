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
    document.documentElement.removeAttribute("style");
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

  it("only offers the retained appearance controls", () => {
    render(<AppearanceSection />);
    for (const label of ["Design", "Compact Detail top menu", "Interface font", "Content font", "Bottom bar buttons"]) {
      expect(screen.queryByRole("group", { name: label })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("group", { name: "Spacing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
  });

  it("offers only 32, 24 and 16 pixel spacing", () => {
    render(<AppearanceSection />);
    expect(screen.getByRole("button", { name: "32" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "24" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "16" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "24" }));
    expect(localStorage.getItem("mine.spacing")).toBe("24");
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

  it("applies the card corner radius and broadcasts it", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("button", { name: "3" }));

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius-card")).toBe("3px");
    // Feed-card media is out of scope and stays square.
    expect(root.style.getPropertyValue("--radius-media")).toBe("");
    expect(localStorage.getItem("mine.cardRadius")).toBe("3");
    expect(emit).toHaveBeenCalledWith("settings-changed", { key: "mine.cardRadius" });
  });

  it("reflects stored values on mount", () => {
    localStorage.setItem("theme", "light");
    localStorage.setItem("mine.scrollEdgeFade", "true");

    render(<AppearanceSection />);

    expect(
      screen.getByRole("checkbox", { name: "Fade content under the chrome" }),
    ).toHaveAttribute("data-state", "checked");

    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
