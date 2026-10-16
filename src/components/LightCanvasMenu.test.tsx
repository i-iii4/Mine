import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { LIGHT_CANVAS_STORAGE_KEY, getLightCanvas, reloadLightCanvas } from "@/lib/lightCanvas";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DisplayMenu } from "./DisplayMenu";
import { LightCanvasMenu } from "./LightCanvasMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

/// TRIAL (PLAN 47.7): «Light canvas» in the Display panel.
describe("LightCanvasMenu", () => {
  afterEach(() => {
    localStorage.removeItem(LIGHT_CANVAS_STORAGE_KEY);
    document.documentElement.removeAttribute("data-theme");
    reloadLightCanvas();
  });

  it("offers White, chosen by default, and Soft, in the feed's and the graph's panel", async () => {
    for (const panel of ["feed", "graph"] as const) {
      const user = userEvent.setup();
      const { unmount } = render(<DisplayMenu panel={panel}>{null}</DisplayMenu>);
      await user.click(screen.getByRole("button", { name: "Display options" }));
      const group = screen.getByRole("group", { name: "Light canvas" });
      expect(group).toHaveAttribute("data-display-trial");
      expect(screen.getByRole("menuitemradio", { name: "White" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menuitemradio", { name: "Soft" })).toHaveAttribute("aria-checked", "false");
      unmount();
    }
  });

  it("shows the canvas chosen elsewhere", async () => {
    localStorage.setItem(LIGHT_CANVAS_STORAGE_KEY, "soft");
    reloadLightCanvas();
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <LightCanvasMenu />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menuitemradio", { name: "Soft" })).toHaveAttribute("aria-checked", "true");
  });

  it("chooses Soft, keeps the panel open and tells the other tabs and windows", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const user = userEvent.setup();
    render(<DisplayMenu panel="feed">{null}</DisplayMenu>);
    await user.click(screen.getByRole("button", { name: "Display options" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Soft" }));
    expect(getLightCanvas()).toBe("soft");
    expect(document.documentElement.hasAttribute("data-light-canvas-soft")).toBe(true);
    expect(screen.getByRole("menuitemradio", { name: "Soft" })).toHaveAttribute("aria-checked", "true");
    expect(vi.mocked(emit)).toHaveBeenCalledWith("settings-changed", expect.objectContaining({ key: LIGHT_CANVAS_STORAGE_KEY }));
  });
});
