import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPreviews } from "@/lib/commands";
import type { PreviewItem } from "@/types";
import { useChannelPreviewsEvents } from "./useChannelPreviewsEvents";

vi.mock("@/lib/commands", () => ({
  listChannelPreviews: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Probe({ thumbsRootPath }: { thumbsRootPath: string | null }) {
  const { channelPreviews } = useChannelPreviewsEvents({
    thumbsRootPath,
    limit: 20,
  });
  return (
    <output data-testid="previews">
      {JSON.stringify(Array.from(channelPreviews.entries()))}
    </output>
  );
}

describe("useChannelPreviewsEvents", () => {
  beforeEach(() => {
    vi.mocked(listChannelPreviews).mockReset();
  });

  it("ignores stale preview snapshots from a previous thumbs root", async () => {
    const oldSnapshot = deferred<Record<string, PreviewItem[]>>();
    const newSnapshot = deferred<Record<string, PreviewItem[]>>();
    const listChannelPreviewsMock = vi.mocked(listChannelPreviews);
    listChannelPreviewsMock
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(newSnapshot.promise);

    const { rerender } = render(<Probe thumbsRootPath="/old/thumbs" />);
    await waitFor(() => expect(listChannelPreviewsMock).toHaveBeenCalledTimes(1));

    rerender(<Probe thumbsRootPath="/new/thumbs" />);
    await waitFor(() => expect(listChannelPreviewsMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      newSnapshot.resolve({
        "__all__": [{ slug: "new-all", text: false, mtime: 2, has_thumb: true }],
        "new-channel": [{ slug: "new-card", text: false, mtime: 2, has_thumb: true }],
      });
      await newSnapshot.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("previews")).toHaveTextContent("new-channel");
    });

    await act(async () => {
      oldSnapshot.resolve({
        "__all__": [{ slug: "old-all", text: false, mtime: 1, has_thumb: true }],
        "old-channel": [{ slug: "old-card", text: false, mtime: 1, has_thumb: true }],
      });
      await oldSnapshot.promise;
    });

    expect(screen.getByTestId("previews")).toHaveTextContent("new-channel");
    expect(screen.getByTestId("previews")).not.toHaveTextContent("old-channel");
  });

  it("refreshes previews on focus to recover an already stale sidebar map", async () => {
    const listChannelPreviewsMock = vi.mocked(listChannelPreviews);
    listChannelPreviewsMock
      .mockResolvedValueOnce({
        "__all__": [{ slug: "old-all", text: false, mtime: 1, has_thumb: true }],
      })
      .mockResolvedValueOnce({
        "__all__": [{ slug: "new-all", text: false, mtime: 2, has_thumb: true }],
        "new-channel": [{ slug: "new-card", text: false, mtime: 2, has_thumb: true }],
      });

    render(<Probe thumbsRootPath="/thumbs" />);

    await waitFor(() => {
      expect(screen.getByTestId("previews")).toHaveTextContent("old-all");
    });
    expect(screen.getByTestId("previews")).not.toHaveTextContent("new-channel");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(listChannelPreviewsMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("previews")).toHaveTextContent("new-channel");
    });
  });
});
