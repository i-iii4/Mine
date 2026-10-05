import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  addKnownVault,
  forgetKnownVault,
  listSpaces,
  reorderKnownVaults,
  showSpace,
  spacesInTabs,
  spaceStats,
} from "@/lib/commands";
import type { SpaceEntry, SpaceStats } from "@/types";
import { SpacesSection, reorderedPaths } from "./SpacesSection";

/** The space list as the backend returns it: every known space, available,
 *  with an identity named after its folder. */
function spaces(...paths: string[]): SpaceEntry[] {
  return paths.map((path) => {
    const name = path.split("/").pop() ?? path;
    return { vault_id: `id-${name}`, path, name, available: true, current: false };
  });
}

vi.mock("@/lib/commands", () => ({
  listSpaces: vi.fn(),
  spacesInTabs: vi.fn(),
  showSpace: vi.fn(),
  addKnownVault: vi.fn(),
  forgetKnownVault: vi.fn(),
  reorderKnownVaults: vi.fn(),
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

function emitOpenSpaces(ids: string[]) {
  act(() => {
    window.dispatchEvent(new CustomEvent("spaces-open-changed", { detail: { payload: ids } }));
  });
}

describe("SpacesSection", () => {
  beforeEach(() => {
    vi.mocked(listSpaces)
      .mockReset()
      .mockResolvedValue(spaces("/Users/me/Mine", "/Users/me/Archive"));
    vi.mocked(spacesInTabs).mockReset().mockResolvedValue(["id-Mine"]);
    vi.mocked(showSpace).mockReset().mockResolvedValue(undefined);
    vi.mocked(spaceStats).mockReset().mockImplementation(async (path: string) => {
      if (path === "/Users/me/Mine") return MINE_STATS;
      if (path === "/Users/me/Archive") return ARCHIVE_STATS;
      if (path === "/Users/me/Work") return ARCHIVE_STATS;
      throw new Error(`unknown space: ${path}`);
    });
    vi.mocked(addKnownVault).mockReset();
    vi.mocked(forgetKnownVault).mockReset();
    vi.mocked(reorderKnownVaults).mockReset();
    vi.mocked(open).mockReset();
  });

  it("marks every space open in a tab with the active background, no text badge", async () => {
    vi.mocked(listSpaces).mockResolvedValue(
      spaces("/Users/me/Mine", "/Users/me/Archive", "/Users/me/Work"),
    );
    vi.mocked(spacesInTabs).mockResolvedValue(["id-Mine", "id-Work"]);
    renderSpaces();
    await screen.findByText("Mine");

    await waitFor(() => expect(spaceRowOf("Mine")).toHaveAttribute("data-space-open"));
    expect(spaceRowOf("Mine").className).toContain("state-active");
    expect(spaceRowOf("Work")).toHaveAttribute("data-space-open");
    expect(spaceRowOf("Work").className).toContain("state-active");
    expect(spaceRowOf("Archive")).not.toHaveAttribute("data-space-open");
    expect(spaceRowOf("Archive").className).toContain("bg-accent");
    // No single current space any more, and no visible badge.
    expect(document.querySelector("[aria-current]")).toBeNull();
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
  });

  it("does not drive the highlight from the legacy current flag", async () => {
    vi.mocked(listSpaces).mockResolvedValue([
      { ...spaces("/Users/me/Mine")[0]!, current: true },
      ...spaces("/Users/me/Archive"),
    ]);
    vi.mocked(spacesInTabs).mockResolvedValue(["id-Archive"]);
    renderSpaces();
    await screen.findByText("Mine");

    await waitFor(() => expect(spaceRowOf("Archive")).toHaveAttribute("data-space-open"));
    expect(spaceRowOf("Mine")).not.toHaveAttribute("data-space-open");
  });

  it("never marks a space the registry has no identity for", async () => {
    vi.mocked(listSpaces).mockResolvedValue([
      { vault_id: null, path: "/Users/me/Mine", name: "Mine", available: true, current: false },
    ]);
    vi.mocked(spacesInTabs).mockResolvedValue(["id-Mine"]);
    renderSpaces();
    await screen.findByText("Mine");
    await waitFor(() => expect(spacesInTabs).toHaveBeenCalled());
    expect(spaceRowOf("Mine")).not.toHaveAttribute("data-space-open");
  });

  it("follows tabs opening and closing spaces through spaces-open-changed", async () => {
    renderSpaces();
    await screen.findByText("Archive");
    await waitFor(() => expect(spaceRowOf("Mine")).toHaveAttribute("data-space-open"));

    emitOpenSpaces(["id-Archive"]);

    await waitFor(() => expect(spaceRowOf("Archive")).toHaveAttribute("data-space-open"));
    expect(spaceRowOf("Mine")).not.toHaveAttribute("data-space-open");

    emitOpenSpaces([]);
    await waitFor(() => expect(spaceRowOf("Archive")).not.toHaveAttribute("data-space-open"));
  });

  it("lists a space a tab created once it opens there", async () => {
    renderSpaces();
    await screen.findByText("Archive");

    vi.mocked(listSpaces).mockResolvedValue(
      spaces("/Users/me/Mine", "/Users/me/Archive", "/Users/me/Work"),
    );
    emitOpenSpaces(["id-Mine", "id-Work"]);

    expect(await screen.findByText("Work")).toBeInTheDocument();
    await waitFor(() => expect(spaceRowOf("Work")).toHaveAttribute("data-space-open"));
    await waitFor(() => expect(spaceStats).toHaveBeenCalledWith("/Users/me/Work"));
    // The spaces already scanned are not walked again.
    expect(vi.mocked(spaceStats).mock.calls.filter(([path]) => path === "/Users/me/Mine")).toHaveLength(1);
  });

  it("follows a space whose folder moved", async () => {
    renderSpaces();
    await screen.findByText("Archive");

    vi.mocked(listSpaces).mockResolvedValue(spaces("/Users/me/Mine", "/Volumes/Disk/Archive"));
    act(() => {
      window.dispatchEvent(new CustomEvent("space-moved", {
        detail: { payload: { vault_id: "id-Archive", path: "/Volumes/Disk/Archive" } },
      }));
    });

    expect(await screen.findByText("/Volumes/Disk/Archive")).toBeInTheDocument();
    expect(screen.queryByText("/Users/me/Archive")).not.toBeInTheDocument();
  });

  it("shows only space controls, without standing instructions or an iCloud card", async () => {
    renderSpaces();
    await screen.findByText("Mine");

    expect(screen.getByRole("heading", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Space" })).toBeInTheDocument();
    expect(screen.queryByText(/Click a space to switch/)).not.toBeInTheDocument();
    expect(screen.queryByText("Files in iCloud")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show space in Finder" })).not.toBeInTheDocument();
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

  it("keeps the space list usable while a filesystem permission request is pending", async () => {
    const pendingStats = new Promise<SpaceStats>(() => {});
    vi.mocked(spaceStats).mockImplementation((path: string) =>
      path === "/Users/me/Mine" ? pendingStats : Promise.resolve(ARCHIVE_STATS),
    );
    renderSpaces();

    await screen.findByText("Mine");
    const mineRow = spaceRowOf("Mine");
    expect(within(mineRow).getByText("…")).toBeInTheDocument();
    expect(await screen.findByText("Archive")).toBeInTheDocument();

    fireEvent.click(spaceRowOf("Archive"));
    await waitFor(() => {
      expect(showSpace).toHaveBeenCalledWith("/Users/me/Archive", false);
    });
  });

  it("shows a failed scan only in its own row", async () => {
    vi.mocked(spaceStats).mockImplementation((path: string) =>
      path === "/Users/me/Mine"
        ? Promise.reject(new Error("permission denied"))
        : Promise.resolve(ARCHIVE_STATS),
    );
    renderSpaces();

    await screen.findByText("Mine");
    const mineRow = spaceRowOf("Mine");
    const archiveRow = spaceRowOf("Archive");
    await waitFor(() => {
      expect(within(mineRow).getByText("—")).toBeInTheDocument();
      expect(within(archiveRow).getByText(/12 files/)).toBeInTheDocument();
    });
  });

  it("shows the space in a tab on row click, an open row included", async () => {
    renderSpaces();
    await screen.findByText("Archive");

    fireEvent.click(spaceRowOf("Archive"));
    await waitFor(() => {
      expect(showSpace).toHaveBeenCalledWith("/Users/me/Archive", false);
    });
    // The highlight waits for the backend's spaces-open-changed.
    expect(spaceRowOf("Archive")).not.toHaveAttribute("data-space-open");

    // An open row brings its tab forward.
    fireEvent.click(spaceRowOf("Mine"));
    await waitFor(() => {
      expect(showSpace).toHaveBeenCalledWith("/Users/me/Mine", false);
    });
  });

  it("opens a space from the keyboard", async () => {
    renderSpaces();
    await screen.findByText("Archive");
    fireEvent.keyDown(spaceRowOf("Archive"), { key: "Enter" });
    await waitFor(() => {
      expect(showSpace).toHaveBeenCalledWith("/Users/me/Archive", false);
    });
  });

  it("shows why a space could not be shown", async () => {
    vi.mocked(showSpace).mockRejectedValue(new Error("no window"));
    renderSpaces();
    await screen.findByText("Archive");
    fireEvent.click(spaceRowOf("Archive"));
    expect(await screen.findByText(/no window/)).toBeInTheDocument();
  });

  it("removes a space that is not open", async () => {
    vi.mocked(forgetKnownVault).mockResolvedValue(["/Users/me/Mine"]);
    renderSpaces();
    await screen.findByText("Archive");

    openRowMenu(spaceRowOf("Archive"));
    const remove = await screen.findByRole("menuitem", { name: /Remove Space/ });
    expect(remove).toHaveTextContent("Files stay on disk");
    fireEvent.click(remove);

    await waitFor(() => {
      expect(forgetKnownVault).toHaveBeenCalledWith("/Users/me/Archive");
    });
    expect(showSpace).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Archive")).not.toBeInTheDocument();
    });
  });

  it("forgets a space open in tabs at once, without showing another first", async () => {
    // В70: the backend sends that space's tabs to the space picker.
    vi.mocked(forgetKnownVault).mockResolvedValue(["/Users/me/Archive"]);
    renderSpaces();
    await screen.findByText("Mine");
    await waitFor(() => expect(spaceRowOf("Mine")).toHaveAttribute("data-space-open"));

    openRowMenu(spaceRowOf("Mine"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove Space/ }));

    await waitFor(() => {
      expect(forgetKnownVault).toHaveBeenCalledWith("/Users/me/Mine");
    });
    expect(showSpace).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Mine")).not.toBeInTheDocument();
    });
  });

  it("lists a space whose folder is gone as unavailable, without opening it", async () => {
    vi.mocked(listSpaces).mockResolvedValue([
      ...spaces("/Users/me/Mine"),
      { vault_id: "id-Gone", path: "/Users/me/Gone", name: "Gone", available: false, current: false },
    ]);
    renderSpaces();
    await screen.findByText("Gone");
    const row = spaceRowOf("Gone");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText(/Folder unavailable/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(showSpace).not.toHaveBeenCalled();
    expect(spaceStats).not.toHaveBeenCalledWith("/Users/me/Gone");
  });

  it("forgets the sole space too", async () => {
    vi.mocked(listSpaces).mockResolvedValue(spaces("/Users/me/Mine"));
    vi.mocked(forgetKnownVault).mockResolvedValue([]);
    renderSpaces();
    await screen.findByText("Mine");

    openRowMenu(spaceRowOf("Mine"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove Space/ }));

    await waitFor(() => {
      expect(forgetKnownVault).toHaveBeenCalledWith("/Users/me/Mine");
    });
    expect(showSpace).not.toHaveBeenCalled();
    expect(await screen.findByText("No known spaces")).toBeInTheDocument();
  });

  it("adds a space through the native directory picker without opening it", async () => {
    vi.mocked(open).mockResolvedValue("/Users/me/New Space");
    vi.mocked(addKnownVault).mockResolvedValue([
      "/Users/me/Mine",
      "/Users/me/Archive",
      "/Users/me/New Space",
    ]);
    vi.mocked(spaceStats).mockResolvedValue(ARCHIVE_STATS);
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
    expect(showSpace).not.toHaveBeenCalled();
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
