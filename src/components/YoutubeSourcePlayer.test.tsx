import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { sourceVideoDownloadStatus, youtubePlayerUrl } from "@/lib/commands";
import { parseYoutubeSource } from "@/lib/youtubeSource";
import { DeleteSourceVideoDialog, YoutubeSourcePlayer } from "./YoutubeSourcePlayer";

vi.mock("@/lib/commands", () => ({
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  startSourceVideoDownload: vi.fn(async () => null),
  youtubePlayerUrl: vi.fn(async () => "http://localhost:4321/youtube/9KDDhAOyv9k"),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

const SOURCE_URL = "https://www.youtube.com/watch?v=9KDDhAOyv9k";

function renderPlayer() {
  const source = parseYoutubeSource(SOURCE_URL);
  if (!source) throw new Error("The test source must be a YouTube video");
  return render(
    <YoutubeSourcePlayer
      slug="film"
      source={source}
      poster={null}
      title="Film"
      onDelete={vi.fn(async () => {})}
      onDownloaded={vi.fn(async () => {})}
    />,
  );
}

describe("YoutubeSourcePlayer", () => {
  beforeEach(() => {
    vi.mocked(sourceVideoDownloadStatus).mockReset();
  });

  it("shows why a download failed while the card was closed (Г4.4)", async () => {
    // The failure event fired with no player mounted; the shell still holds it.
    const message = "Disk is gone. The video is kept and will be added the next time this space opens.";
    vi.mocked(sourceVideoDownloadStatus).mockResolvedValue({ state: "failed", message });
    renderPlayer();
    expect(await screen.findByText(`Download failed: ${message}`)).toBeInTheDocument();
    expect(sourceVideoDownloadStatus).toHaveBeenCalledWith("film");
  });

  it("keeps a newer event over a stored state that answers after it", async () => {
    let answer!: (status: { state: "failed"; message: string }) => void;
    vi.mocked(sourceVideoDownloadStatus).mockImplementation(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    renderPlayer();
    // A retry started elsewhere reports progress before the old failure answers.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("source-video-download", {
        detail: { payload: { slug: "film", state: "downloading", percent: 10 } },
      }));
    });
    await act(async () => answer({ state: "failed", message: "Old failure." }));
    expect(screen.getByText("Downloading 10%")).toBeInTheDocument();
    expect(screen.queryByText(/Old failure/)).toBeNull();
  });

  it.each([
    ["finished", { state: "done" } as const],
    ["cancelled", { state: "cancelled" } as const],
  ])("shows nothing for a download that %s while the card was closed", async (_case, status) => {
    vi.mocked(sourceVideoDownloadStatus).mockResolvedValue(status);
    const { container } = renderPlayer();
    await act(async () => {});
    expect(container.querySelector("[data-source-video-download]")).toBeNull();
  });
});

describe("DeleteSourceVideoDialog", () => {
  // DESIGN_SYSTEM.md, «Тексты окон»: the link and the poster leave the
  // element for good; the poster file goes to the Trash unless it is shared.
  it("says what leaves the element for good and where the poster goes", () => {
    render(<DeleteSourceVideoDialog open onOpenChange={vi.fn()} onDelete={vi.fn(async () => {})} />);

    const dialog = screen.getByRole("alertdialog", { name: "Delete embed from element?" });
    expect(dialog).toHaveAccessibleDescription(
      "The video link and its poster are removed from this element and cannot be restored. The poster file goes to the Trash unless another element uses it.",
    );
  });

  // SPEC_DEEP_AUDIT.md, Е6.8: the poster shown while the player loads.
  it("shows no broken-image icon for a poster whose file will not load", async () => {
    vi.mocked(youtubePlayerUrl).mockImplementationOnce(() => new Promise<string>(() => {}));
    const source = parseYoutubeSource(SOURCE_URL);
    if (!source) throw new Error("The test source must be a YouTube video");
    const { container } = render(
      <YoutubeSourcePlayer
        slug="film"
        source={source}
        poster="asset://localhost/Media/film.jpg"
        title="Film"
        onDelete={vi.fn(async () => {})}
        onDownloaded={vi.fn(async () => {})}
      />,
    );
    const poster = container.querySelector("img") as HTMLImageElement;
    expect(poster).not.toBeNull();
    fireEvent.error(poster);
    expect(container.querySelector("img")).toBeNull();
  });
});
