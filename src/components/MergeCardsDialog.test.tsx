import { render, screen } from "@testing-library/react";
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
});
