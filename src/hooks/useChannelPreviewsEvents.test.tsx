import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPreviews } from "@/lib/commands";
import type { ChannelPreviewsSnapshot } from "@/types";
import { useChannelPreviewsEvents } from "./useChannelPreviewsEvents";
import {
  createProjectionRevisionOwner,
  type ProjectionRevisionOwner,
} from "./useProjectionRevisionOwner";

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

function Probe({
  thumbsRootPath,
  revisionOwner,
}: {
  thumbsRootPath: string | null;
  revisionOwner?: ProjectionRevisionOwner;
}) {
  const { channelPreviews } = useChannelPreviewsEvents({
    thumbsRootPath,
    limit: 20,
    revisionOwner,
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
    const oldSnapshot = deferred<ChannelPreviewsSnapshot>();
    const newSnapshot = deferred<ChannelPreviewsSnapshot>();
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
        generation: 2,
        previews: {
          "__all__": [{ slug: "new-all", text: false, mtime: 2, has_thumb: true }],
          "new-channel": [{ slug: "new-card", text: false, mtime: 2, has_thumb: true }],
        },
      });
      await newSnapshot.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("previews")).toHaveTextContent("new-channel");
    });

    await act(async () => {
      oldSnapshot.resolve({
        generation: 1,
        previews: {
          "__all__": [{ slug: "old-all", text: false, mtime: 1, has_thumb: true }],
          "old-channel": [{ slug: "old-card", text: false, mtime: 1, has_thumb: true }],
        },
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
        generation: 1,
        previews: {
          "__all__": [{ slug: "old-all", text: false, mtime: 1, has_thumb: true }],
        },
      })
      .mockResolvedValueOnce({
        generation: 2,
        previews: {
          "__all__": [{ slug: "new-all", text: false, mtime: 2, has_thumb: true }],
          "new-channel": [{ slug: "new-card", text: false, mtime: 2, has_thumb: true }],
        },
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

  it("does not publish a snapshot older than the vault projection owner", async () => {
    const owner = createProjectionRevisionOwner();
    owner.accept("sidebar-previews", 5);
    vi.mocked(listChannelPreviews).mockResolvedValue({
      generation: 4,
      previews: {
        "__all__": [{ slug: "stale", text: false, mtime: 1, has_thumb: true }],
      },
    });

    render(<Probe thumbsRootPath="/thumbs" revisionOwner={owner} />);

    await waitFor(() => expect(listChannelPreviews).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("previews")).not.toHaveTextContent("stale");
  });
});
