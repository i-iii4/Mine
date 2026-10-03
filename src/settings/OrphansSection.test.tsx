import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  deleteOrphanMedia,
  listOrphanMedia,
  listSpaces,
  promoteOrphanMedia,
  spacesInTabs,
} from "@/lib/commands";
import type { OrphanMedia, SpaceEntry } from "@/types";
import { OrphansSection } from "./OrphansSection";

vi.mock("@/lib/commands", () => ({
  listOrphanMedia: vi.fn(),
  listSpaces: vi.fn(),
  spacesInTabs: vi.fn(),
  promoteOrphanMedia: vi.fn(),
  deleteOrphanMedia: vi.fn(),
}));

const ORPHANS: OrphanMedia[] = [
  { file_name: "loose-photo.jpg", size_bytes: 2_400_000, modified_secs: 1_700_000_000 },
  { file_name: "clip.mp4", size_bytes: 12_000_000, modified_secs: 1_700_000_100 },
];
const ARCHIVE_ORPHANS: OrphanMedia[] = [
  { file_name: "old-scan.png", size_bytes: 1_000, modified_secs: 1_600_000_000 },
];
const SPACE = "space-id";
const ARCHIVE = "archive-id";

const KNOWN: SpaceEntry[] = [
  { vault_id: SPACE, path: "/vault", name: "vault", available: true, current: false },
  { vault_id: ARCHIVE, path: "/archive", name: "Archive", available: true, current: false },
  { vault_id: "closed-id", path: "/closed", name: "Closed", available: true, current: false },
];

function chooseSpace(name: string) {
  const trigger = screen.getByRole("button", { name: /^Space:/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

describe("OrphansSection", () => {
  beforeEach(() => {
    vi.mocked(listOrphanMedia).mockReset().mockImplementation(async (vaultId?: string) => (
      vaultId === ARCHIVE
        ? { vault_id: ARCHIVE, orphans: ARCHIVE_ORPHANS }
        : { vault_id: SPACE, orphans: ORPHANS }
    ));
    vi.mocked(listSpaces).mockReset().mockResolvedValue(KNOWN);
    vi.mocked(spacesInTabs).mockReset().mockResolvedValue([SPACE]);
    vi.mocked(promoteOrphanMedia).mockReset();
    vi.mocked(deleteOrphanMedia).mockReset();
  });

  it("renders the orphan list with count, image previews and sizes", async () => {
    render(<OrphansSection />);

    expect(await screen.findByText("loose-photo.jpg")).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Orphans/ })).toHaveTextContent("2");
    // Decimal base — sizes match Finder (formatBytes).
    expect(screen.getByText("2.4 MB")).toBeInTheDocument();

    // Image orphans get an asset preview from the chosen space's folder;
    // video orphans a placeholder slot.
    const image = document.querySelector("img") as HTMLImageElement;
    expect(image.src).toContain("/vault/loose-photo.jpg");
    expect(listOrphanMedia).toHaveBeenCalledWith(SPACE);
  });

  it("shows the empty state when there are no orphans", async () => {
    vi.mocked(listOrphanMedia).mockResolvedValue({ vault_id: SPACE, orphans: [] });
    render(<OrphansSection />);

    expect(await screen.findByText("No orphan media")).toBeInTheDocument();
  });

  it("asks for an open space when no tab shows one", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([]);
    render(<OrphansSection />);

    expect(await screen.findByText("Open a space to find its orphan media.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Orphans" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Space:/ })).toBeNull();
    expect(listOrphanMedia).not.toHaveBeenCalled();
  });

  it("lists only the spaces open in tabs and acts on the one chosen", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([SPACE, ARCHIVE]);
    vi.mocked(promoteOrphanMedia).mockResolvedValue({ created: [], skipped: [] });
    render(<OrphansSection />);

    // The first open space by default.
    await screen.findByText("loose-photo.jpg");
    expect(screen.getByRole("button", { name: "Space: vault" })).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: /^Space:/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const choices = screen.getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(choices).toEqual(["vault", "Archive"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Archive" }));

    expect(await screen.findByText("old-scan.png")).toBeInTheDocument();
    expect(listOrphanMedia).toHaveBeenLastCalledWith(ARCHIVE);
    expect(screen.queryByText("loose-photo.jpg")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Space: Archive" })).toBeInTheDocument();
    expect((document.querySelector("img") as HTMLImageElement).src).toContain("/archive/old-scan.png");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select old-scan.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Convert to Elements" }));
    await waitFor(() => {
      expect(promoteOrphanMedia).toHaveBeenCalledWith(ARCHIVE, ["old-scan.png"]);
    });
  });

  it("drops the selection made for another space", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([SPACE, ARCHIVE]);
    render(<OrphansSection />);
    await screen.findByText("loose-photo.jpg");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select loose-photo.jpg" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    chooseSpace("Archive");
    await screen.findByText("old-scan.png");
    expect(screen.getByText("Select all")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Convert to Elements" })).toBeNull();
  });

  it("falls back to an open space when the chosen one closes", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([SPACE, ARCHIVE]);
    render(<OrphansSection />);
    await screen.findByText("loose-photo.jpg");
    chooseSpace("Archive");
    await screen.findByText("old-scan.png");

    act(() => {
      window.dispatchEvent(new CustomEvent("spaces-open-changed", { detail: { payload: [SPACE] } }));
    });

    expect(await screen.findByText("loose-photo.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Space: vault" })).toBeInTheDocument();
  });

  it("select all toggles every row and shows indeterminate for partial selection", async () => {
    render(<OrphansSection />);
    await screen.findByText("loose-photo.jpg");

    const selectAll = screen.getByRole("checkbox", { name: "Select all orphans" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select loose-photo.jpg" }));
    expect(selectAll).toHaveAttribute("data-state", "indeterminate");
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.click(selectAll);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select clip.mp4" }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("converts the selection to elements and reloads the list", async () => {
    vi.mocked(promoteOrphanMedia).mockResolvedValue({
      created: [],
      skipped: ["loose-photo.jpg"],
    });
    render(<OrphansSection />);
    await screen.findByText("loose-photo.jpg");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select loose-photo.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Convert to Elements" }));

    await waitFor(() => {
      expect(promoteOrphanMedia).toHaveBeenCalledWith(SPACE, ["loose-photo.jpg"]);
    });
    expect(await screen.findByText("Converted 0, skipped 1")).toBeInTheDocument();
    // Initial load + reload after the batch.
    expect(listOrphanMedia).toHaveBeenCalledTimes(2);
  });

  it("refreshes the list after a partial Trash failure and shows the error", async () => {
    vi.mocked(deleteOrphanMedia).mockRejectedValue(new Error("Trash refused remaining files"));
    render(<OrphansSection />);
    await screen.findByText("clip.mp4");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select clip.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Trash refused remaining files/)).toBeInTheDocument();
    await waitFor(() => expect(listOrphanMedia).toHaveBeenCalledTimes(2));
  });

  it("deletes only after confirmation", async () => {
    vi.mocked(deleteOrphanMedia).mockResolvedValue({
      deleted: ["clip.mp4"],
      skipped: [],
    });
    render(<OrphansSection />);
    await screen.findByText("clip.mp4");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select clip.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Confirm dialog: nothing deleted yet.
    expect(deleteOrphanMedia).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Files are moved to the system Trash.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteOrphanMedia).toHaveBeenCalledWith(SPACE, ["clip.mp4"]);
    });
    expect(await screen.findByText("Deleted 1, skipped 0")).toBeInTheDocument();
  });
});
