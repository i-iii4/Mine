import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPreviews } from "@/lib/commands";
import type { ChannelPreviewsSnapshot, PreviewCard } from "@/types";
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
    revisionOwner,
  });
  return (
    <output data-testid="previews">
      {JSON.stringify(Array.from(channelPreviews.entries()))}
    </output>
  );
}

/** What the last render of `Holder` returned, for identity checks. */
const held = { previews: new Map<string, PreviewCard[]>(), refresh: async () => {} };

function Holder() {
  const { channelPreviews, refresh } = useChannelPreviewsEvents({ thumbsRootPath: "/thumbs" });
  held.previews = channelPreviews;
  held.refresh = refresh;
  return null;
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

  it("reads the whole list, with no limit, and points each card at its micro level", async () => {
    vi.mocked(listChannelPreviews).mockResolvedValue({
      generation: 1,
      previews: { "__all__": [{ slug: "photo", text: false, mtime: 3, has_thumb: true }] },
    });

    render(<Holder />);

    await waitFor(() => expect(held.previews.get("__all__")).toHaveLength(1));
    expect(listChannelPreviews).toHaveBeenCalledWith();
    expect(held.previews.get("__all__")?.[0]?.url).toBe("asset://localhost//thumbs/photo.micro.jpg?m=3");
  });

  it("keeps the lists, and the map, a read did not change", async () => {
    const card = (slug: string, mtime = 1) => ({ slug, text: false, mtime, has_thumb: true });
    vi.mocked(listChannelPreviews)
      .mockResolvedValueOnce({ generation: 1, previews: { "__all__": [card("a"), card("b")], Art: [card("a")], City: [card("b")] } })
      .mockResolvedValueOnce({ generation: 2, previews: { "__all__": [card("a"), card("b")], Art: [card("a")], City: [card("b")] } })
      .mockResolvedValueOnce({ generation: 3, previews: { "__all__": [card("a"), card("b", 2)], Art: [card("a")], City: [card("b", 2)] } });

    render(<Holder />);
    await waitFor(() => expect(held.previews.size).toBe(3));
    const first = held.previews;

    await act(async () => { await held.refresh(); });
    expect(held.previews).toBe(first);

    await act(async () => { await held.refresh(); });
    expect(held.previews).not.toBe(first);
    expect(held.previews.get("Art")).toBe(first.get("Art"));
    expect(held.previews.get("City")).not.toBe(first.get("City"));
    // One card object per card, shared by every row it stands in.
    expect(held.previews.get("__all__")?.[0]).toBe(held.previews.get("Art")?.[0]);
    expect(held.previews.get("City")?.[0]?.url).toMatch(/b\.micro\.jpg\?m=2$/);
  });
});
