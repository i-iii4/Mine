import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  addKnownVault,
  forgetKnownVault,
  getVaultPath,
  listKnownVaults,
  reorderKnownVaults,
  selectVault,
  spaceStats,
} from "@/lib/commands";
import type { SpaceStats } from "@/types";
import { SpacesSection, reorderedPaths } from "./SpacesSection";

vi.mock("@/lib/commands", () => ({
  listKnownVaults: vi.fn(),
  getVaultPath: vi.fn(),
  addKnownVault: vi.fn(),
  forgetKnownVault: vi.fn(),
  reorderKnownVaults: vi.fn(),
  selectVault: vi.fn(),
  spaceStats: vi.fn(),
}));

const MINE_STATS: SpaceStats = {
  file_count: 1240,
  markdown_count: 640,
  media_count: 580,
  total_bytes: 4_200_000_000,
  element_count: 620,
};

const ARCHIVE_STATS: SpaceStats = {
  file_count: 12,
  markdown_count: 8,
  media_count: 4,
  total_bytes: 52_000,
  element_count: null,
};

function renderSpaces() {
  return render(
    <TooltipProvider>
      <SpacesSection />
    </TooltipProvider>,
  );
}

function spaceRowOf(name: string): HTMLElement {
  const title = screen.getByText(name);
  const row = title.closest("[data-space-row]");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function openRowMenu(row: HTMLElement) {
  const trigger = within(row).getByRole("button", { name: /Space actions/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe("SpacesSection", () => {
  beforeEach(() => {
    vi.mocked(listKnownVaults)
      .mockReset()
      .mockResolvedValue(["/Users/me/Mine", "/Users/me/Archive"]);
    vi.mocked(getVaultPath).mockReset().mockResolvedValue("/Users/me/Mine");
    vi.mocked(spaceStats).mockReset().mockImplementation(async (path: string) => {
      if (path === "/Users/me/Mine") return MINE_STATS;
      if (path === "/Users/me/Archive") return ARCHIVE_STATS;
      throw new Error(`unknown space: ${path}`);
    });
    vi.mocked(addKnownVault).mockReset();
    vi.mocked(forgetKnownVault).mockReset();
    vi.mocked(reorderKnownVaults).mockReset();
    vi.mocked(selectVault).mockReset().mockResolvedValue({
      path: "",
      indexed: 0,
      requires_migration: false,
    } as never);
    vi.mocked(open).mockReset();
  });

  it("marks the active space with the active background, no text badge", async () => {
    renderSpaces();
    await screen.findByText("Mine");

    const mineRow = spaceRowOf("Mine");
    const archiveRow = spaceRowOf("Archive");
    expect(mineRow).toHaveAttribute("aria-current", "true");
    expect(mineRow.className).toContain("bg-active");
    expect(archiveRow).not.toHaveAttribute("aria-current");
    expect(archiveRow.className).toContain("bg-accent");
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
  });

  it("shows per-space stats with the size closing the summary line", async () => {
    renderSpaces();
    await screen.findByText("Mine");

    const mineRow = spaceRowOf("Mine");
    await waitFor(() => {
      expect(
        within(mineRow).getByText(
          "620 elements · 640 markdown · 580 media · 1240 files · 4.2 GB",
        ),
      ).toBeInTheDocument();
    });

    const archiveRow = spaceRowOf("Archive");
    await waitFor(() => {
      expect(
        within(archiveRow).getByText(
          "— elements · 8 markdown · 4 media · 12 files · 52 KB",
        ),
      ).toBeInTheDocument();
    });
  });

  it("switches the space on row click and ignores clicks on the active row", async () => {
    renderSpaces();
    await screen.findByText("Archive");

    fireEvent.click(spaceRowOf("Mine"));
    expect(selectVault).not.toHaveBeenCalled();

    fireEvent.click(spaceRowOf("Archive"));
    await waitFor(() => {
      expect(selectVault).toHaveBeenCalledWith("/Users/me/Archive");
    });
    await waitFor(() => {
      expect(spaceRowOf("Archive")).toHaveAttribute("aria-current", "true");
    });
  });

  it("follows switches that originate elsewhere via vault-selected", async () => {
    renderSpaces();
    await screen.findByText("Archive");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("vault-selected", {
          detail: { payload: { path: "/Users/me/Archive" } },
        }),
      );
    });

    await waitFor(() => {
      expect(spaceRowOf("Archive")).toHaveAttribute("aria-current", "true");
    });
  });

  it("removes a non-active space without switching", async () => {
    vi.mocked(forgetKnownVault).mockResolvedValue(["/Users/me/Mine"]);
    renderSpaces();
    await screen.findByText("Archive");

    openRowMenu(spaceRowOf("Archive"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove Space/ }));

    await waitFor(() => {
      expect(forgetKnownVault).toHaveBeenCalledWith("/Users/me/Archive");
    });
    expect(selectVault).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Archive")).not.toBeInTheDocument();
    });
  });

  it("removing the active space switches to the next one first", async () => {
    vi.mocked(forgetKnownVault).mockResolvedValue(["/Users/me/Archive"]);
    renderSpaces();
    await screen.findByText("Mine");

    openRowMenu(spaceRowOf("Mine"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove Space/ }));

    await waitFor(() => {
      expect(selectVault).toHaveBeenCalledWith("/Users/me/Archive");
      expect(forgetKnownVault).toHaveBeenCalledWith("/Users/me/Mine");
    });
    // Switch happens before forget — the config invariant holds.
    const switchOrder = vi.mocked(selectVault).mock.invocationCallOrder[0]!;
    const forgetOrder = vi.mocked(forgetKnownVault).mock.invocationCallOrder[0]!;
    expect(switchOrder).toBeLessThan(forgetOrder);
  });

  it("removing the sole space forgets it without switching", async () => {
    vi.mocked(listKnownVaults).mockResolvedValue(["/Users/me/Mine"]);
    vi.mocked(forgetKnownVault).mockResolvedValue([]);
    renderSpaces();
    await screen.findByText("Mine");

    openRowMenu(spaceRowOf("Mine"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove Space/ }));

    await waitFor(() => {
      expect(forgetKnownVault).toHaveBeenCalledWith("/Users/me/Mine");
    });
    expect(selectVault).not.toHaveBeenCalled();
  });

  it("adds a space through the native directory picker without switching", async () => {
    vi.mocked(open).mockResolvedValue("/Users/me/New Space");
    vi.mocked(addKnownVault).mockResolvedValue([
      "/Users/me/Mine",
      "/Users/me/Archive",
      "/Users/me/New Space",
    ]);
    renderSpaces();

    fireEvent.click(await screen.findByRole("button", { name: "Add Space" }));

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
      expect(addKnownVault).toHaveBeenCalledWith("/Users/me/New Space");
    });
    expect(await screen.findByText("New Space")).toBeInTheDocument();
    await waitFor(() => {
      expect(spaceStats).toHaveBeenCalledWith("/Users/me/New Space");
    });
    expect(selectVault).not.toHaveBeenCalled();
  });

  it("does nothing when the picker is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    renderSpaces();

    fireEvent.click(await screen.findByRole("button", { name: "Add Space" }));

    await waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
    expect(addKnownVault).not.toHaveBeenCalled();
  });
});

describe("reorderedPaths", () => {
  const PATHS = ["/a", "/b", "/c"];

  it("moves the dragged path to the drop position", () => {
    expect(reorderedPaths(PATHS, "/a", "/c")).toEqual(["/b", "/c", "/a"]);
    expect(reorderedPaths(PATHS, "/c", "/a")).toEqual(["/c", "/a", "/b"]);
  });

  it("returns null when the drop changes nothing or ids are unknown", () => {
    expect(reorderedPaths(PATHS, "/a", "/a")).toBeNull();
    expect(reorderedPaths(PATHS, "/a", "/nope")).toBeNull();
    expect(reorderedPaths(PATHS, "/nope", "/a")).toBeNull();
  });
});
