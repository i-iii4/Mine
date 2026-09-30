import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { MAX_BLOB_VIDEO_BYTES, VideoFromBlob } from "./VideoFromBlob";

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
      headers: new Headers({ "Content-Length": "5" }),
      blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
    } as unknown as Response);
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

    expect(fetchMock).toHaveBeenCalledWith("asset://localhost//vault/demo.mp4", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:video-preview");
  });

  it("falls back to blob fetch after a stalled direct load timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Length": "5" }),
      blob: () => Promise.resolve(new Blob(["video"], { type: "video/mp4" })),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<VideoFromBlob src="asset://localhost//vault/stalled.mp4" autoPlay muted loop />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("asset://localhost//vault/stalled.mp4", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps a video too large for memory on its direct source (А7.6)", async () => {
    const blob = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Length": String(MAX_BLOB_VIDEO_BYTES + 1) }),
      blob,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<VideoFromBlob src="asset://localhost//vault/long.mp4" autoPlay muted loop />);
    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    expect(blob).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")).toHaveAttribute("src", "asset://localhost//vault/long.mp4");
  });

  it("learns the size with HEAD and reads nothing of a file over the limit (Б3.5)", async () => {
    const body = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      headers: new Headers(
        init?.method === "HEAD" ? { "Content-Length": String(200 * 1024 * 1024) } : {},
      ),
      get body() { return body(); },
      blob: body,
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<VideoFromBlob src="asset://localhost//vault/film.mp4" autoPlay muted loop />);
    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "HEAD" }));
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toHaveAttribute("src", "asset://localhost//vault/film.mp4");
  });

  it("a playback error after the refusal does not read the file again (Б3.5)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "Content-Length": String(MAX_BLOB_VIDEO_BYTES + 1) }),
      blob: vi.fn(),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<VideoFromBlob src="asset://localhost//vault/long.mp4" autoPlay muted loop />);
    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("video")).toHaveAttribute("src", "asset://localhost//vault/long.mp4");

    // WebKit cannot play it directly either: the same element errors again.
    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")).toHaveAttribute("src", "asset://localhost//vault/long.mp4");
  });

  it("stops a read without a declared size once it passes the limit (Б3.5)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const read = vi.fn(async () => ({ done: false as const, value: chunk }));
    let readSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") throw new TypeError("HEAD is not supported");
      readSignal = init?.signal ?? undefined;
      return {
        ok: true,
        headers: new Headers(),
        body: { getReader: () => ({ read }) },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<VideoFromBlob src="asset://localhost//vault/stream.mp4" />);
    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await vi.advanceTimersByTimeAsync(0);
    });

    // The read ends with the first chunk past the limit, not at the end of
    // the file, and the request is cancelled.
    expect(read).toHaveBeenCalledTimes(Math.floor(MAX_BLOB_VIDEO_BYTES / chunk.byteLength) + 1);
    expect(readSignal?.aborted).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toHaveAttribute("src", "asset://localhost//vault/stream.mp4");
  });

  it("stops reading the video when it is closed (А7.6)", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, unmount } = render(<VideoFromBlob src="asset://localhost//vault/slow.mp4" />);
    await act(async () => {
      fireEvent.error(container.querySelector("video")!);
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
