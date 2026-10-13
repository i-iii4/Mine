import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LightBlock, TagCount } from "@/types";
import { GroupSelectionCommands } from "./GroupSelectionCommands";
import { GroupSelectionCardMenu } from "./GroupSelectionCardMenu";

function block(slug: string): LightBlock {
  return {
    id: 1,
    slug,
    card_kind: "article",
    block_type: "article",
    title: slug,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-10-13T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: ["alpha"],
    feed_playback: null,
  } as LightBlock;
}

const selection = [block("one"), block("two")];
const tags: TagCount[] = [{ tag: "alpha", count: 2 }];

/** A membership command on its way, answered by the test. */
function pendingAnswer() {
  let answer!: (applied: boolean) => void;
  const onBatchSetTag = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  return { onBatchSetTag, answer: (applied: boolean) => answer(applied) };
}

/// SPEC_DEEP_AUDIT.md, Е6.1: the selection's Disconnect keeps the selection
/// until the answer. A Disconnect that was made clears it; one that was not
/// keeps it, so it can be tried again, and the tab's notice says why.
describe("the selection's Disconnect", () => {
  it.each([[true, 1], [false, 0]] as const)(
    "in the commands row clears the selection only after a Disconnect that was made (made: %s)",
    async (applied, clears) => {
      const { onBatchSetTag, answer } = pendingAnswer();
      const onClearSelection = vi.fn();
      render(
        <GroupSelectionCommands
          selectedBlocks={selection}
          tags={tags}
          currentTag="alpha"
          onLoadBlockTags={vi.fn(async () => new Map())}
          onBatchSetTag={onBatchSetTag}
          onCreateAndAssignBatch={vi.fn()}
          onRequestDeleteSelection={vi.fn()}
          onMergeSelectedBlocks={vi.fn()}
          onClearSelection={onClearSelection}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
      expect(onClearSelection).not.toHaveBeenCalled();

      await act(async () => answer(applied));

      expect(onClearSelection).toHaveBeenCalledTimes(clears);
    },
  );

  it.each([[true, 1], [false, 0]] as const)(
    "in the ⌘K menu clears the selection only after a Disconnect that was made (made: %s)",
    async (applied, clears) => {
      const { onBatchSetTag, answer } = pendingAnswer();
      const onClearSelection = vi.fn();
      render(
        <GroupSelectionCardMenu
          selectedBlocks={selection}
          tags={tags}
          currentTag="alpha"
          openRequestSequence={1}
          onLoadBlockTags={vi.fn(async () => new Map())}
          onBatchSetTag={onBatchSetTag}
          onCreateAndAssignBatch={vi.fn()}
          onRequestDeleteSelection={vi.fn()}
          onMergeSelectedBlocks={vi.fn()}
          onClearSelection={onClearSelection}
        />,
      );

      fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
      await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
      expect(onClearSelection).not.toHaveBeenCalled();

      await act(async () => answer(applied));

      expect(onClearSelection).toHaveBeenCalledTimes(clears);
    },
  );
});
