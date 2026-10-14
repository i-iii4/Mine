import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { lightBlock } from "@/test/blocks";
import { useGroupSelectionMenuActions } from "./useGroupSelectionMenuActions";

const selection = [lightBlock({ slug: "one" }), lightBlock({ slug: "two" })];

function actions(input: { currentTag?: string; applied: boolean | undefined }) {
  const onLoadBlockTags = vi.fn(async () => new Map([["one", ["alpha"]], ["two", ["alpha"]]]));
  const onBatchSetTag = vi.fn(async () => input.applied);
  const hook = renderHook(() =>
    useGroupSelectionMenuActions({
      selectedBlocks: selection,
      currentTag: input.currentTag,
      onLoadBlockTags,
      onBatchSetTag,
      onCreateAndAssignBatch: vi.fn(),
    }),
  );
  return { ...hook, onLoadBlockTags, onBatchSetTag };
}

/// SPEC_DEEP_AUDIT.md, Е6.1; SPEC_GROUP_SELECTION.md, «Batch Connect»: the
/// rows change at once, and a batch that was not made answers so and shows
/// the selection's collections as they are again.
describe("useGroupSelectionMenuActions", () => {
  it("answers a batch that was made and keeps the rows it changed", async () => {
    const { result, onBatchSetTag, onLoadBlockTags } = actions({ applied: true });
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.batchSetTag(["one", "two"], "beta", true);
    });
    expect(answer).toBe(true);
    expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "beta", true);
    expect(onLoadBlockTags).not.toHaveBeenCalled();
    expect(result.current.tagLookup.get("one")).toEqual(["beta"]);
  });

  it("answers a batch that was refused and reads the selection's collections again", async () => {
    const { result, onLoadBlockTags } = actions({ applied: false });
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.batchSetTag(["one", "two"], "beta", true);
    });
    expect(answer).toBe(false);
    expect(onLoadBlockTags).toHaveBeenCalledWith(["one", "two"]);
    await waitFor(() => expect(result.current.tagLookup.get("one")).toEqual(["alpha"]));
  });

  it("disconnects the selection from the open collection and answers whether it was made", async () => {
    const { result, onBatchSetTag } = actions({ currentTag: "alpha", applied: false });
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.disconnectFromCurrentCollection();
    });
    expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false);
    expect(answer).toBe(false);
  });

  it("answers that nothing was made outside a collection", async () => {
    const { result, onBatchSetTag } = actions({ applied: true });
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.disconnectFromCurrentCollection();
    });
    expect(answer).toBe(false);
    expect(onBatchSetTag).not.toHaveBeenCalled();
  });

  it("says in the error's words why the collections could not be read", async () => {
    const onLoadBlockTags = vi.fn(async () => Promise.reject(new Error("The index is not open.")));
    const { result } = renderHook(() =>
      useGroupSelectionMenuActions({
        selectedBlocks: selection,
        onLoadBlockTags,
        onBatchSetTag: vi.fn(),
        onCreateAndAssignBatch: vi.fn(),
      }),
    );
    act(() => result.current.setConnectOpen(true));
    await waitFor(() => expect(result.current.actionError).toBe("The index is not open."));
  });
});
