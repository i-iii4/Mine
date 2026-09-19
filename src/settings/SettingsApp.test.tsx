import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsApp } from "./SettingsApp";

vi.mock("@/lib/commands", () => ({
  listKnownVaults: vi.fn().mockResolvedValue([]),
  getVaultPath: vi.fn().mockResolvedValue(null),
  addKnownVault: vi.fn(),
  forgetKnownVault: vi.fn(),
  reorderKnownVaults: vi.fn(),
  selectVault: vi.fn(),
  spaceStats: vi.fn().mockResolvedValue({
    file_count: 0,
    markdown_count: 0,
    media_count: 0,
    total_bytes: 0,
    element_count: null,
  }),
  listOrphanMedia: vi.fn().mockResolvedValue([]),
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
    expect(appearance.className).toContain("bg-active");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  it("switches sections and moves the active row", async () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Spaces" }));
    expect(await screen.findByRole("heading", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spaces" }).className).toContain("bg-active");
    expect(
      screen.getByRole("button", { name: "Appearance" }).className,
    ).not.toContain("bg-active");

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByRole("heading", { name: "Graph" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Orphans" }));
    expect(await screen.findByRole("heading", { name: /Orphans/ })).toBeInTheDocument();
  });

  it("titles the chrome bar Settings", () => {
    renderSettings();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("chrome-row");
    expect(header).toHaveAttribute("data-chrome-separator", "bottom");
    expect(header).not.toHaveClass("border-b");
  });
});
