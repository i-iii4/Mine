import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  deleteOrphanMedia,
  getVaultPath,
  listOrphanMedia,
  promoteOrphanMedia,
} from "@/lib/commands";
import type { OrphanMedia } from "@/types";
import { OrphansSection } from "./OrphansSection";

vi.mock("@/lib/commands", () => ({
  listOrphanMedia: vi.fn(),
  getVaultPath: vi.fn(),
  promoteOrphanMedia: vi.fn(),
  deleteOrphanMedia: vi.fn(),
}));

const ORPHANS: OrphanMedia[] = [
  { file_name: "loose-photo.jpg", size_bytes: 2_400_000, modified_secs: 1_700_000_000 },
  { file_name: "clip.mp4", size_bytes: 12_000_000, modified_secs: 1_700_000_100 },
];

describe("OrphansSection", () => {
  beforeEach(() => {
    vi.mocked(listOrphanMedia).mockReset().mockResolvedValue(ORPHANS);
    vi.mocked(getVaultPath).mockReset().mockResolvedValue("/vault");
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

    // Image orphans get an asset preview; video orphans a placeholder slot.
    const image = document.querySelector("img") as HTMLImageElement;
    expect(image.src).toContain("loose-photo.jpg");
  });

  it("shows the empty state when there are no orphans", async () => {
    vi.mocked(listOrphanMedia).mockResolvedValue([]);
    render(<OrphansSection />);

    expect(await screen.findByText("No orphan media")).toBeInTheDocument();
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
      expect(promoteOrphanMedia).toHaveBeenCalledWith(["loose-photo.jpg"]);
    });
    expect(await screen.findByText("Converted 0, skipped 1")).toBeInTheDocument();
    // Initial load + reload after the batch.
    expect(listOrphanMedia).toHaveBeenCalledTimes(2);
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
      expect(deleteOrphanMedia).toHaveBeenCalledWith(["clip.mp4"]);
    });
    expect(await screen.findByText("Deleted 1, skipped 0")).toBeInTheDocument();
  });
});
