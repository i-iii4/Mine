import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_VIDEO_BLOB_TIMEOUT_MS,
  FEED_VIDEO_DIRECT_TIMEOUT_MS,
  FEED_VIDEO_FETCH_TIMEOUT_MS,
  FEED_VIDEO_MAX_RETRIES,
  FEED_VIDEO_RETRY_DELAY_MS,
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
    expect(container.querySelector("img")).toHaveAttribute("draggable", "false");
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
    expect(video).toHaveAttribute("draggable", "false");

    await act(async () => {
      fireEvent.loadedData(video!);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_DIRECT_TIMEOUT_MS + 50);
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-feed-video-phase='playing_direct']")).toBeTruthy();
  });

  it("keeps the poster visually above video while direct playback is loading", () => {
    playSpy.mockImplementationOnce(() => new Promise(() => {}));

    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );

    const poster = container.querySelector("img");
    const video = container.querySelector("video");
    expect(poster).toHaveClass("z-10", "opacity-100");
    expect(video).toHaveClass("z-0", "opacity-0");
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

  it("keeps heavy direct playback mounted while it is still loading", async () => {
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
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_DIRECT_TIMEOUT_MS * 5);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBeInTheDocument();
    expect(container.querySelector("[data-feed-video-phase='loading_direct']")).toBeTruthy();
  });

  it("sends a heavy clip straight to poster-only on a direct error without buffering a blob", async () => {
    // heavy clips have no upper size cap, so their unbounded file must never be
    // pulled into a memory blob: a direct error is terminal (until retry), not a
    // blob fallback.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

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
      fireEvent.error(container.querySelector("video")!);
      await Promise.resolve();
    });

    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBeNull();
  });

  it("keeps the standard blob fallback on a direct error", async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
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
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(container.querySelector("[data-feed-video-phase='loading_blob']")).toBeTruthy();
  });

  it("retries a heavy clip from loading_direct after it degrades to poster-only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

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
      fireEvent.error(container.querySelector("video")!);
      await Promise.resolve();
    });
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();

    // Let the retry attempt hang so it stays observable in loading_direct.
    playSpy.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_RETRY_DELAY_MS);
    });
    expect(container.querySelector("[data-feed-video-phase='loading_direct']")).toBeTruthy();
    // Recovery is memory-free: the retry never buffers a blob.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a hung blob fetch after the fetch timeout, then retries from poster-only", async () => {
    // A fetch that never delivers bytes (dataless iCloud file / lost network).
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
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
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(container.querySelector("[data-feed-video-phase='loading_blob']")).toBeTruthy();

    // The fetch never resolves; after the fetch-stage budget it is aborted and
    // the surface degrades to poster-only instead of hanging in loading_blob.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_FETCH_TIMEOUT_MS + 50);
    });
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();

    // From poster-only the existing retry re-attempts direct playback.
    playSpy.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_RETRY_DELAY_MS);
    });
    expect(container.querySelector("[data-feed-video-phase='loading_direct']")).toBeTruthy();
  });

  it("does not start the blob timeout until the fetch delivers the bytes", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
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
    });
    expect(fetchMock).toHaveBeenCalled();

    // The blob timeout budget covers decode + play only, so a fetch that
    // outlasts it must not fail the surface.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_BLOB_TIMEOUT_MS + 500);
    });
    expect(container.querySelector("[data-feed-video-phase='loading_blob']")).toBeTruthy();

    await act(async () => {
      resolveFetch?.({
        ok: true,
        blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:feed-video");
  });

  it("retries autoplay from failed_poster_only after the retry delay", async () => {
    playSpy.mockImplementation(() => Promise.reject(new Error("autoplay blocked")));
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

    // Direct play rejects, blob fetch rejects → poster-only.
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();

    // Let the next direct attempt hang so the retry lands in loading_direct and
    // stays observable instead of instantly re-failing.
    playSpy.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_RETRY_DELAY_MS);
    });
    expect(container.querySelector("[data-feed-video-phase='loading_direct']")).toBeTruthy();
  });

  it("stops retrying once the retry cap is reached", async () => {
    playSpy.mockImplementation(() => Promise.reject(new Error("autoplay blocked")));
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
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();

    // Each retry re-fails through direct → blob → poster-only.
    for (let i = 0; i < FEED_VIDEO_MAX_RETRIES; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FEED_VIDEO_RETRY_DELAY_MS);
        for (let j = 0; j < 6; j++) await Promise.resolve();
      });
    }
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();

    // Beyond the cap there is no further retry: fetch is not called again.
    const callsAfterCap = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEED_VIDEO_RETRY_DELAY_MS * 3);
    });
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsAfterCap);
  });

  it("shows the play badge over the poster and after degrading to poster-only", async () => {
    const { container, rerender } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback={false}
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="h-full w-full object-cover"
      />,
    );
    expect(container.querySelector("[data-feed-video-phase='poster']")).toBeTruthy();
    expect(container.querySelector("[data-feed-play-badge]")).toBeTruthy();

    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);
    rerender(
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
    expect(container.querySelector("[data-feed-video-phase='failed_poster_only']")).toBeTruthy();
    expect(container.querySelector("[data-feed-play-badge]")).toBeTruthy();
  });
});

describe("FeedVideoSurface: the video's box in whole pixels (SPEC_CARD_MEDIA_GEOMETRY.md, «Коробка видео в целых пикселях»)", () => {
  /** A layout's resize observer: reports `slot` for the surface it observes. */
  function installSlot(slot: { width: number; height: number }) {
    class SlotResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        const rect: DOMRect = {
          x: 0, y: 0, top: 0, left: 0, width: slot.width, height: slot.height,
          right: slot.width, bottom: slot.height, toJSON: () => ({}),
        };
        const size = [{ inlineSize: slot.width, blockSize: slot.height }];
        this.callback([{ target, contentRect: rect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size }], this);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", SlotResizeObserver);
  }

  /** The video's own pixels, as the engine reports them once metadata loads. */
  function loadMetadata(video: HTMLVideoElement, width: number, height: number) {
    Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
    fireEvent.loadedMetadata(video);
  }

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draws a 16:9 video in a 225 by 127 slot at 226 by 127 whole pixels, unscaled inside its box", () => {
    installSlot({ width: 225, height: 127 });
    const { container } = render(
      <FeedVideoSurface
        playback={{ ...PLAYBACK, width: 1920, height: 1080 }}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="absolute inset-0 h-full w-full object-cover"
      />,
    );
    const video = container.querySelector("video")!;
    act(() => loadMetadata(video, 1920, 1080));

    expect(video.style.width).toBe("226px");
    expect(video.style.height).toBe("127px");
    expect(video.style.left).toBe("0px");
    expect(video.style.top).toBe("0px");
    // Drawn exactly at its box: the engine works out no cover size of its own.
    expect(video.style.objectFit).toBe("fill");
    expect(video.style.maxWidth).toBe("none");
    expect(video).not.toHaveClass("object-cover", "inset-0", "h-full", "w-full");
  });

  it("centres a wide video's overflow on whole pixels", () => {
    installSlot({ width: 225, height: 113 });
    const { container } = render(
      <FeedVideoSurface playback={PLAYBACK} allowPlayback vaultPath="/tmp/vault" thumbsRootPath="/tmp/thumbs" />,
    );
    const video = container.querySelector("video")!;
    act(() => loadMetadata(video, 2400, 1000));
    expect([video.style.left, video.style.top, video.style.width, video.style.height]).toEqual(["-23px", "0px", "271px", "113px"]);
  });

  it("keeps the caller's cover until the video's own pixels are known", () => {
    installSlot({ width: 225, height: 127 });
    const { container } = render(
      <FeedVideoSurface
        playback={PLAYBACK}
        allowPlayback
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        className="absolute inset-0 h-full w-full object-cover"
      />,
    );
    const video = container.querySelector("video")!;
    expect(video).toHaveClass("object-cover", "inset-0");
    expect(video.style.width).toBe("");
  });
});
