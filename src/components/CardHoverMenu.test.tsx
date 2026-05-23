import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CardHoverMenu, CardMoreMenu } from "./CardHoverMenu";
import { getBlock } from "@/lib/commands";
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

function dragPastChromeThreshold(element: HTMLElement) {
  fireEvent.pointerDown(element, {
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(window, {
    pointerId: 1,
    clientX: 18,
    clientY: 10,
  });
  fireEvent.pointerUp(window, {
    pointerId: 1,
    clientX: 18,
    clientY: 10,
  });
  fireEvent.click(element);
}

describe("CardHoverMenu", () => {
  const startDragging = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentWindow).mockReturnValue({
      startDragging,
    } as never);
    vi.mocked(getBlock).mockResolvedValue({ tags: [] } as Awaited<ReturnType<typeof getBlock>>);
  });

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

  it("uses conservative overflow menu icons and Disconnect terminology", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      { tags: ["design"] } as Awaited<ReturnType<typeof getBlock>>,
    );

    render(
      <CardMoreMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        currentTag="design"
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openRequestSequence={1}
      />,
    );

    const connectItem = await screen.findByText("Connect");
    const sourceItem = await screen.findByText("Source");
    const revealItem = await screen.findByText("Reveal in Finder");
    const copyItem = await screen.findByText("Copy Path");
    const renameItem = await screen.findByText("Rename…");
    const disconnectItem = await screen.findByText('Disconnect from “design”');
    const deleteItem = await screen.findByText("Delete");

    expect(screen.queryByText(/Remove from/)).not.toBeInTheDocument();

    expect(connectItem.closest("[role='menuitem']")?.querySelector("svg")).toBeTruthy();
    expect(sourceItem.closest("[role='menuitem']")?.querySelector("svg")).toBeTruthy();
    for (const item of [revealItem, copyItem, renameItem, disconnectItem, deleteItem]) {
      const menuItem = item.closest("[role='menuitem']");
      expect(menuItem?.querySelector("[data-card-menu-icon-slot]")).toBeTruthy();
      expect(menuItem?.querySelector("svg")).toBeNull();
    }
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

  it("opts CardMoreMenu trigger into top-chrome drag without opening the menu", async () => {
    render(
      <CardMoreMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        topChromeInteraction
      />,
    );

    const trigger = screen.getByRole("button");
    dragPastChromeThreshold(trigger);

    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Rename…")).not.toBeInTheDocument();

    fireEvent.pointerDown(trigger, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerUp(window, {
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(trigger);

    expect(await screen.findByText("Rename…")).toBeInTheDocument();
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
