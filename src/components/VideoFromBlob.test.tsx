import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { VideoFromBlob } from "./VideoFromBlob";

describe("VideoFromBlob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:video-preview"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefers direct video src and skips blob fetch when media loads normally", async () => {
    const { container } = render(
      <VideoFromBlob src="asset://localhost//vault/demo.mp4" autoPlay muted loop />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "asset://localhost//vault/demo.mp4");
    expect(video).toHaveAttribute("preload", "auto");

    fireEvent.loadedData(video!);
    await vi.advanceTimersByTimeAsync(3000);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to blob fetch when the direct video path errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <VideoFromBlob src="asset://localhost//vault/demo.mp4" autoPlay muted loop />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();

    await act(async () => {
      fireEvent.error(video!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("asset://localhost//vault/demo.mp4");
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:video-preview");
  });

  it("falls back to blob fetch after a stalled direct load timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<VideoFromBlob src="asset://localhost//vault/stalled.mp4" autoPlay muted loop />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("asset://localhost//vault/stalled.mp4");
  });
});
