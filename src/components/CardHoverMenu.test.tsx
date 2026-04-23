import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CardHoverMenu } from "./CardHoverMenu";
import type { LightBlock } from "@/types";

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => ({ tags: [] })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

function makeBlock(): LightBlock {
  return {
    id: 1,
    slug: "alpha-block",
    block_type: "article",
    title: "Alpha Title",
    url: "https://example.com",
    media_file: null,
    thumbnail: null,
    saved_at: "2026-04-23T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
  };
}

describe("CardHoverMenu", () => {
  it("shows Rename in the overflow menu", async () => {
    const onRequestRename = vi.fn();

    render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={onRequestRename}
        onRequestDelete={vi.fn()}
      />,
    );

    const trigger = screen.getAllByRole("button")[0]!;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    const renameItem = await screen.findByText("Rename…");
    fireEvent.click(renameItem);

    await waitFor(() => {
      expect(onRequestRename).toHaveBeenCalledWith(expect.objectContaining({ slug: "alpha-block" }));
    });
  });
});
