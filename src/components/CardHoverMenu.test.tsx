import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CardHoverMenu, CardMoreMenu } from "./CardHoverMenu";
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
  it("opens the overflow menu from a keyboard action request", async () => {
    const { container, rerender } = render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openMoreMenuRequestSequence={1}
      />,
    );

    expect(await screen.findByText("Rename…")).toBeInTheDocument();
    expect(container.querySelector("[data-card-hover-more-action]")).toHaveClass("opacity-100");
    expect(container.querySelector("[data-card-hover-bottom-actions]")).toHaveClass("opacity-0");

    rerender(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openMoreMenuRequestSequence={2}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
    });
  });

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

  it("closes the overflow menu from Command-K inside the menu surface", async () => {
    render(
      <CardMoreMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openRequestSequence={1}
      />,
    );

    const renameItem = await screen.findByText("Rename…");
    fireEvent.keyDown(renameItem, { key: "k", metaKey: true });

    await waitFor(() => {
      expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
    });
  });

  it("can disable CSS hover affordances while keeping programmatic menu requests", async () => {
    const { container } = render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openMoreMenuRequestSequence={1}
        hoverEnabled={false}
      />,
    );

    expect(await screen.findByText("Rename…")).toBeInTheDocument();
    expect(container.querySelector("[data-card-hover-more-action]")).toHaveClass("opacity-100");
    expect(container.querySelector("[data-card-hover-more-action]")).toHaveClass("pointer-events-auto");
    expect(container.querySelector("[data-card-hover-more-action]")).not.toHaveClass("group-hover:opacity-100");
    expect(container.querySelector("[data-card-hover-bottom-actions]")).toHaveClass("opacity-0");
    expect(container.querySelector("[data-card-hover-bottom-actions]")).toHaveClass("pointer-events-none");
    expect(container.querySelector("[data-card-hover-bottom-actions]")).not.toHaveClass("group-hover:opacity-100");
  });

  it("reports keyboard-opened overflow menu state separately from pointer menus", async () => {
    const onKeyboardMoreMenuOpenChange = vi.fn();
    const { rerender } = render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openMoreMenuRequestSequence={1}
        onKeyboardMoreMenuOpenChange={onKeyboardMoreMenuOpenChange}
      />,
    );

    expect(await screen.findByText("Rename…")).toBeInTheDocument();
    expect(onKeyboardMoreMenuOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openMoreMenuRequestSequence={2}
        onKeyboardMoreMenuOpenChange={onKeyboardMoreMenuOpenChange}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
    });
    expect(onKeyboardMoreMenuOpenChange).toHaveBeenLastCalledWith(false);
  });
});
