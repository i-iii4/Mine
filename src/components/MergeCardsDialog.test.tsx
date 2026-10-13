import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LightBlock } from "@/types";
import { MergeCardsDialog } from "./MergeCardsDialog";

function lightBlock(id: number, slug: string): LightBlock {
  return {
    id,
    slug,
    block_type: "article",
    card_kind: "article",
    title: slug,
    content_heading: null,
    display_title: slug,
    fallback_label: slug,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-10-11T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    collections: [],
    search_match: null,
  };
}

describe("MergeCardsDialog", () => {
  // DESIGN_SYSTEM.md, «Тексты окон»: the sources go to the Trash, and the
  // links that now lead to the new element stay so after a restore.
  it("says the merged elements go to the Trash and their links move", () => {
    render(
      <MergeCardsDialog
        open
        selectedBlocks={[lightBlock(1, "First"), lightBlock(2, "Second")]}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Drag to set the order. These elements go to the Trash; links to them now lead to the new element, even if you restore them.",
    );
  });

  function rowOrder(): (string | null)[] {
    return screen
      .getAllByRole("button", { name: /^Reorder / })
      .map((handle) => handle.getAttribute("aria-label"));
  }

  // SPEC_DEEP_AUDIT.md, Е1.7: the feed reloads under the open window (a
  // fresh list, another order); the order in the window stays, and Merge
  // sends it. The next opening takes the selection as it is then.
  it("keeps its order while the feed changes under the open window", async () => {
    const onConfirm = vi.fn(async (orderedSlugs: string[]) => {
      expect(orderedSlugs).toHaveLength(2);
    });
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MergeCardsDialog
        open
        selectedBlocks={[lightBlock(1, "First"), lightBlock(2, "Second")]}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    rerender(
      <MergeCardsDialog
        open
        selectedBlocks={[lightBlock(2, "Second"), lightBlock(1, "First")]}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    expect(rowOrder()).toEqual(["Reorder First", "Reorder Second"]);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(["First", "Second"]);
    });

    rerender(
      <MergeCardsDialog
        open={false}
        selectedBlocks={[lightBlock(2, "Second"), lightBlock(1, "First")]}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <MergeCardsDialog
        open
        selectedBlocks={[lightBlock(2, "Second"), lightBlock(1, "First")]}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    expect(rowOrder()).toEqual(["Reorder Second", "Reorder First"]);
  });
});
