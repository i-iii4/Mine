import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { sourceVideoDownloadStatus } from "@/lib/commands";
import { parseYoutubeSource } from "@/lib/youtubeSource";
import { YoutubeSourcePlayer } from "./YoutubeSourcePlayer";

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
