import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_VIDEO_DIRECT_TIMEOUT_MS,
  FEED_VIDEO_HEAVY_DIRECT_TIMEOUT_MS,
  FeedVideoSurface,
} from "./FeedVideoSurface";

const PLAYBACK = {
  kind: "single_video" as const,
  sourcePath: "demo.mp4",
  posterPreviewPath: "demo.jpg",
  width: 1280,
  height: 720,
  container: "mp4" as const,
  profile: "standard" as const,
};

describe("FeedVideoSurface", () => {
  let playSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:feed-video"),
      revokeObjectURL: vi.fn(),
    });
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays poster-only when playback is not allowed", () => {
    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback={false}
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("[data-feed-video-phase='poster']")).toBeTruthy();
  });

  it("plays the direct source when loaded without fetching a blob", async () => {
    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );

    const video = container.querySelector("video");
    expect(video).toHaveAttribute("src", "asset://localhost//tmp/vault/demo.mp4");

    await act(async () => {
      fireEvent.loadedData(video!);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_DIRECT_TIMEOUT_MS + 50);
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-feed-video-phase='playing_direct']")).toBeTruthy();
  });

  it("falls back to blob video after a direct playback error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );

    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "asset://localhost//tmp/vault/demo.mp4",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:feed-video");
  });

  it("falls back to blob when direct play() is rejected without an error event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    playSpy.mockImplementationOnce(() =>
      Promise.reject(new Error("autoplay blocked")),
    );

    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "asset://localhost//tmp/vault/demo.mp4",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:feed-video");
  });

  it("degrades to poster-only when blob fallback fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );

    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();
  });

  it("uses a heavy direct-only policy for heavy autoplay clips", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    playSpy.mockImplementationOnce(() => new Promise(() => {}));

    const { container } = render(
      <FeedVideoSurface
        playback={{ ...PLAYBACK, profile: "heavy" }}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_DIRECT_TIMEOUT_MS + 50);
    });
    expect(container.querySelector("video")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        FEED_VIDEO_HEAVY_DIRECT_TIMEOUT_MS - FEED_VIDEO_DIRECT_TIMEOUT_MS + 50,
      );
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();
  });
});
