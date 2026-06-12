import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("button", { name: "Orphans" }));
    expect(await screen.findByRole("heading", { name: /Orphans/ })).toBeInTheDocument();
  });

  it("titles the chrome bar Settings", () => {
    renderSettings();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
