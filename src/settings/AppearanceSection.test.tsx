import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { setTheme as setTauriTheme } from "@tauri-apps/api/app";
import { act } from "@testing-library/react";
import { AppearanceSection } from "./AppearanceSection";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

describe("AppearanceSection", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    vi.mocked(emit).mockClear();
    vi.mocked(setTauriTheme).mockClear();
  });

  it("applies the chosen theme and broadcasts the change", () => {
    render(<AppearanceSection />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Dark" }), { button: 0 });

    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(setTauriTheme).toHaveBeenLastCalledWith("dark");
    expect(emit).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: "theme" }));
  });

  it("only offers the retained appearance controls", () => {
    render(<AppearanceSection />);
    for (const label of ["Design", "Compact Detail top menu", "Interface font", "Content font", "Bottom bar buttons"]) {
      expect(screen.queryByRole("group", { name: label })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: label })).not.toBeInTheDocument();
    }
    // Spacing moved to the feed's Display panel (SPEC_FEED_DISPLAY.md, Д17).
    expect(screen.queryByRole("group", { name: "Spacing" })).not.toBeInTheDocument();
  });

  it("persists the bottom menu visibility flag and broadcasts its key", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Hide bottom menu" }));

    expect(localStorage.getItem("mine.bottomActionBarHidden")).toBe("true");
    expect(emit).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: "mine.bottomActionBarHidden" }));

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
    expect(emit).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: "mine.scrollEdgeFade" }));

    fireEvent.click(checkbox);
    expect(localStorage.getItem("mine.scrollEdgeFade")).toBe("false");
  });

  it("applies the card corner radius and broadcasts it", () => {
    render(<AppearanceSection />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "4" }), { button: 0 });

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius-card")).toBe("4px");
    // Feed-card media is out of scope and stays square.
    expect(root.style.getPropertyValue("--radius-media")).toBe("");
    expect(localStorage.getItem("mine.cardRadius")).toBe("4");
    expect(emit).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: "mine.cardRadius" }));
  });

  it("reflects stored values on mount", () => {
    localStorage.setItem("theme", "light");
    localStorage.setItem("mine.scrollEdgeFade", "true");

    render(<AppearanceSection />);

    expect(
      screen.getByRole("checkbox", { name: "Fade content under the chrome" }),
    ).toHaveAttribute("data-state", "checked");

    expect(screen.getByRole("tab", { name: "Light" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  describe("Motion (SPEC_MOTION_LEVELS.md, НС1–НС4)", () => {
    /** The system's "Reduce motion", flipped on the fly: the only query the
     *  section's page asks (motion.ts names it; motion.test.ts tests it). */
    function systemMotion(reduce: boolean) {
      let matches = reduce;
      const listeners = new Set<() => void>();
      vi.stubGlobal("matchMedia", () => ({
        get matches() {
          return matches;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }));
      return (next: boolean) => {
        matches = next;
        for (const listener of [...listeners]) listener();
      };
    }

    async function freshSection() {
      vi.resetModules();
      const motion = await import("@/lib/motion");
      const { AppearanceSection: Section } = await import("./AppearanceSection");
      motion.installMotionLevel();
      return Section;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("stands right under Theme as a panel pill of Full, Minimal and Off, with no caption", () => {
      render(<AppearanceSection />);
      const labels = [...document.querySelectorAll("p.text-base:not(.text-muted-foreground)")].map((label) => label.textContent);
      expect(labels.slice(0, 3)).toEqual(["Theme", "Motion", "Card corners"]);
      const pill = screen.getByRole("tablist", { name: "Motion" });
      expect(pill).toHaveAttribute("data-size", "panel");
      expect(screen.getAllByRole("tab").filter((tab) => pill.contains(tab)).map((tab) => tab.textContent)).toEqual(["Full", "Minimal", "Off"]);
      // No caption under the row: its label stands alone.
      const label = labels.indexOf("Motion");
      const row = document.querySelectorAll("p.text-base:not(.text-muted-foreground)")[label]!.parentElement!;
      expect(row.children).toHaveLength(1);
    });

    it("shows the system's level with no choice, and follows it on the fly", async () => {
      const setSystem = systemMotion(true);
      const Section = await freshSection();
      render(<Section />);
      expect(screen.getByRole("tab", { name: "Minimal" })).toHaveAttribute("data-state", "active");
      act(() => setSystem(false));
      expect(screen.getByRole("tab", { name: "Full" })).toHaveAttribute("data-state", "active");
    });

    it("stores the pick, puts it on the root and broadcasts its value", async () => {
      systemMotion(false);
      const Section = await freshSection();
      render(<Section />);
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Off" }), { button: 0 });
      expect(localStorage.getItem("mine.motion")).toBe("off");
      expect(document.documentElement.getAttribute("data-motion")).toBe("off");
      expect(emit).toHaveBeenCalledWith("settings-changed", { key: "mine.motion", value: "off" });
      expect(screen.getByRole("tab", { name: "Off" })).toHaveAttribute("data-state", "active");
    });
  });
});
