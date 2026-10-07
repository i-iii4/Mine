import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCommandOverrides } from "@/lib/commandRegistry";
import { SettingsApp } from "./SettingsApp";

vi.mock("@/lib/commands", () => ({
  reportWindowSurface: vi.fn().mockResolvedValue(undefined),
  listSpaces: vi.fn().mockResolvedValue([]),
  spacesInTabs: vi.fn().mockResolvedValue([]),
  showSpace: vi.fn(),
  addKnownVault: vi.fn(),
  forgetKnownVault: vi.fn(),
  reorderKnownVaults: vi.fn(),
  spaceStats: vi.fn().mockResolvedValue({
    file_count: 0,
    markdown_count: 0,
    media_count: 0,
    total_bytes: 0,
    element_count: null,
  }),
  listOrphanMedia: vi.fn().mockResolvedValue({ vault_id: "space-id", orphans: [] }),
  promoteOrphanMedia: vi.fn(),
  deleteOrphanMedia: vi.fn(),
}));

function renderSettings() {
  return render(
    <TooltipProvider>
      <SettingsApp />
    </TooltipProvider>,
  );
}

describe("SettingsApp", () => {
  beforeEach(() => {
    localStorage.clear();
    setCommandOverrides({});
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("opens a new window directly on the requested section", () => {
    window.history.replaceState(null, "", "/settings.html?section=graph");
    renderSettings();
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-current", "true");
  });

  it("switches an existing window on settings-section and ignores unknown sections", () => {
    renderSettings();
    act(() => window.dispatchEvent(new CustomEvent("settings-section", { detail: { payload: "graph" } })));
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("settings-section", { detail: { payload: "unknown" } })));
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
  });

  it("falls back to Appearance for an unknown deep link", () => {
    window.history.replaceState(null, "", "/settings.html?section=unknown");
    renderSettings();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  it("renders the section navigation with Appearance active by default", () => {
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const appearance = screen.getByRole("button", { name: "Appearance" });
    expect(nav).toContainElement(appearance);
    expect(appearance).toHaveAttribute("aria-current", "true");
    expect(appearance.className).toContain("state-active");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  it("switches sections and moves the active row", async () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Spaces" }));
    expect(await screen.findByRole("heading", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spaces" }).className).toContain("state-active");
    expect(
      screen.getByRole("button", { name: "Appearance" }).className,
    ).not.toContain("state-active");

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByRole("heading", { name: "Graph" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Orphans" }));
    expect(await screen.findByRole("heading", { name: /Orphans/ })).toBeInTheDocument();
  });

  it("leaves the chrome bar without a title, a drag surface only (07.10.2026)", () => {
    renderSettings();
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("chrome-row");
    expect(header).toHaveAttribute("data-chrome-separator", "bottom");
    expect(header).not.toHaveClass("border-b");
    expect(header).toHaveTextContent(/^$/);
    expect(header.querySelector("[data-traffic-light-reserve]")).toHaveAttribute("data-tauri-drag-region");
  });

  it("sets the window's text in the interface font at 14px (07.10.2026)", () => {
    renderSettings();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    for (const item of within(nav).getAllByRole("button")) {
      expect(item).toHaveClass("font-sans", "text-base");
      expect(item).not.toHaveClass("font-mono", "text-sm");
    }
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveClass("text-base", "font-semibold");
    expect(heading).not.toHaveClass("text-lg");
    const offSize = Array.from(document.querySelectorAll("main .text-sm, main .text-xs, main .text-lg"))
      .filter((element) => !element.closest("[data-slot='button']"))
      .map((element) => element.className);
    expect(offSize).toEqual([]);
  });

  it("filters shortcut rows when typing in the opened Settings section", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Shortcuts" }));
    const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
    await user.type(search, "copy path");
    expect(document.querySelectorAll("[data-shortcut-row]")).toHaveLength(1);
    expect(document.querySelector('[data-shortcut-row="copy-path"]')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "cmd+f");
    expect(document.querySelector('[data-shortcut-row="find-elements"]')).toBeInTheDocument();
    expect(document.querySelector('[data-shortcut-row="copy-path"]')).toBeNull();
  });
});
