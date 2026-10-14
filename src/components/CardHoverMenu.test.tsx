import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CardConnectMenu, CardHoverMenu, CardMoreMenu, CardPointMenu } from "./CardHoverMenu";
import { CardTagMenu } from "./CardContextMenu";
import { ActionFailureNoticeStack } from "./ActionFailureNotices";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { getBlock, startWindowDrag } from "@/lib/commands";
import { clearActionFailures } from "@/lib/actionFailures";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import type { LightBlock } from "@/types";
import { indexedBlock, lightBlock } from "@/test/blocks";

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => ({ tags: [] })),
  startWindowDrag: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

const writeText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

function makeBlock(): LightBlock {
  return lightBlock({
    id: 1,
    slug: "alpha-block",
    block_type: "article",
    // A note with an address and no text: the feed shows it as a link.
    card_kind: "link",
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
    collections: [],
    feed_playback: null,
  });
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
  beforeEach(() => {
    vi.clearAllMocks();
    clearActionFailures();
    vi.mocked(getBlock).mockResolvedValue(indexedBlock({ slug: "alpha-block" }));
  });

  /// SPEC_DEEP_AUDIT.md, Е6.12: the menu shows the card's collections the
  /// feed knows from its first frame; the read of the file only refreshes
  /// them, and a read that fails leaves them; before, the menu showed no
  /// membership until the read answered, and a failed read was unhandled.
  it.each([["answers late", () => new Promise<never>(() => {})], ["fails", () => Promise.reject(new Error("index is locked"))]])(
    "shows the card's collections the feed knows while the read %s",
    async (_case, read) => {
      vi.mocked(getBlock).mockImplementation(read as typeof getBlock);
      render(
        <CardMoreMenu
          block={{ ...makeBlock(), collections: ["alpha"] }}
          vaultPath="/vault"
          tags={[{ tag: "alpha", count: 1 }]}
          currentTag="alpha"
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
          openRequestSequence={1}
        />,
      );

      expect(await screen.findByText("Disconnect from “alpha”")).toBeInTheDocument();
      await waitFor(() => expect(getBlock).toHaveBeenCalledWith("alpha-block"));
      expect(screen.getByText("Disconnect from “alpha”")).toBeInTheDocument();
    },
  );

  /// Е6.12: the right-click menu, the same.
  it("shows the card's collections the feed knows in the right-click menu while the read answers late", async () => {
    vi.mocked(getBlock).mockImplementation(() => new Promise<never>(() => {}));
    render(
      <ContextMenu>
        <ContextMenuTrigger>card</ContextMenuTrigger>
        <CardTagMenu
          block={{ ...makeBlock(), collections: ["alpha"] }}
          vaultPath="/vault"
          tags={[{ tag: "alpha", count: 1 }]}
          currentTag="alpha"
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
        />
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("card"));

    expect(await screen.findByText("Disconnect from “alpha”")).toBeInTheDocument();
  });

  /// Decision of 14.10.2026: Source, Reveal in Finder and Copy Path that
  /// fail write to the log; the tab shows no notice.
  it.each([
    ["Source", "Could not open the link"],
    ["Reveal in Finder", "Could not reveal in Finder"],
    ["Copy Path", "Could not copy the path"],
  ])("logs when %s failed and shows nothing", async (item, title) => {
    vi.mocked(invoke).mockClear();
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no browser"));
    vi.mocked(revealItemInDir).mockRejectedValueOnce(new Error("no browser"));
    writeText.mockRejectedValueOnce(new Error("no browser"));
    render(
      <>
        <CardMoreMenu
          block={makeBlock()}
          vaultPath="/vault"
          tags={[]}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
          openRequestSequence={1}
        />
        <ActionFailureNoticeStack />
      </>,
    );

    fireEvent.click(await screen.findByText(item));

    await waitFor(() => {
      const lines = vi.mocked(invoke).mock.calls
        .filter(([command]) => command === "plugin:log|log")
        .map(([, args]) => String((args as { message: string }).message));
      expect(lines.some((line) => line.startsWith(title) && line.endsWith(": no browser"))).toBe(true);
    });
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.queryByText("no browser")).toBeNull();
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

  const HOVER_LAYERS = [
    "[data-card-hover-overlay]",
    "[data-card-hover-more-action]",
  ];
  // The bottom row moves with the card's lift, so its layer comes from the
  // lift's own 3D transform in global.css rather than from `transform-gpu`,
  // which the lift transform would override (SPEC_CARD_STATES.md, С8).
  const BOTTOM_ROW = "[data-card-hover-bottom-actions]";

  it("lifts every hover layer onto its own compositing layer over video", () => {
    const { container } = render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        videoUnderneath
      />,
    );

    // WKWebView promotes <video> into its own compositing layer, and a plain
    // positioned sibling loses to it in paint order despite the higher
    // z-index — the ⋯ button drew underneath feed videos. transform-gpu forces
    // a compositing layer per hover surface so z-order is honoured again.
    for (const selector of HOVER_LAYERS) {
      expect(container.querySelector(selector), selector).toHaveClass("transform-gpu");
    }
    expect(container.querySelector(BOTTOM_ROW)).toHaveAttribute("data-card-lift-gpu");
  });

  it("asks for no layer of its own without video underneath", () => {
    const { container } = render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    // A layer per hover surface on every card cost four times the memory and
    // five times the rendering load at rest (measured 20.08.2026). A card
    // without video has no paint-order fight to win, so it asks for nothing.
    for (const selector of HOVER_LAYERS) {
      expect(container.querySelector(selector), selector).not.toHaveClass("transform-gpu");
    }
    expect(container.querySelector(BOTTOM_ROW)).not.toHaveAttribute("data-card-lift-gpu");
  });

  it("reports when a pointer menu holds the bottom row, the card lift's pin", async () => {
    const onActionsPinnedChange = vi.fn();
    render(
      <CardHoverMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onActionsPinnedChange={onActionsPinnedChange}
      />,
    );

    expect(onActionsPinnedChange).toHaveBeenLastCalledWith(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Connect/ }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    await waitFor(() => expect(onActionsPinnedChange).toHaveBeenLastCalledWith(true));
  });

  // DESIGN_SYSTEM.md, «Ширина» (11.10.2026): the card's menu has the action
  // width; the collections under its search field have the search width,
  // from the menu's Connect and from the plus alike.
  it("gives the card menu the action width and its Connect list the search width", async () => {
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

    const connect = (await screen.findByText("Connect")).closest<HTMLElement>("[role='menuitem']")!;
    expect(document.querySelector("[data-slot='dropdown-menu-content']")).toHaveAttribute(
      "data-floating-menu",
      "action",
    );
    connect.focus();
    fireEvent.keyDown(connect, { key: "ArrowRight" });
    await screen.findByPlaceholderText("Search collections...");
    expect(document.querySelector("[data-slot='dropdown-menu-sub-content']")).toHaveAttribute(
      "data-floating-menu",
      "search",
    );
  });

  it("gives the plus's collection list the search width", async () => {
    render(
      <CardConnectMenu
        block={makeBlock()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connect" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    await screen.findByPlaceholderText("Search collections...");
    expect(document.querySelector("[data-slot='dropdown-menu-content']")).toHaveAttribute(
      "data-floating-menu",
      "search",
    );
  });

  // A collection's name can be any length; the row cuts it with an ellipsis
  // at the menu's width instead of wrapping.
  it("cuts a long collection name in Disconnect with an ellipsis", async () => {
    const name = "a collection whose name is far longer than the menu";
    vi.mocked(getBlock).mockResolvedValueOnce(indexedBlock({ slug: "alpha-block", tags: [name] }));
    render(
      <CardMoreMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        currentTag={name}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        openRequestSequence={1}
      />,
    );

    const label = await screen.findByText(`Disconnect from “${name}”`);
    expect(label).toHaveClass("min-w-0", "truncate");
    expect(label.parentElement).toHaveAttribute("role", "menuitem");
  });

  it("copies the card path through the native clipboard, not the web API", async () => {
    // navigator.clipboard rejects once Radix closes the menu and focus leaves
    // the document, and the rejection was swallowed — the button did nothing.
    const webClipboard = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: webClipboard },
    });

    render(
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

    fireEvent.click(await screen.findByText("Copy Path"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/vault/alpha-block.md");
    });
    expect(webClipboard).not.toHaveBeenCalled();
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

    const trigger = screen.getByRole("button", { name: "Card actions" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    const renameItem = await screen.findByText("Rename…");
    fireEvent.click(renameItem);

    await waitFor(() => {
      expect(onRequestRename).toHaveBeenCalledWith(expect.objectContaining({ slug: "alpha-block" }));
    });
  });

  it("uses conservative overflow menu icons and Disconnect terminology", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(indexedBlock({ slug: "alpha-block", tags: ["design"] }));

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
    // Disconnect (Unlink) and Delete (Trash2) now carry real icons.
    expect(disconnectItem.closest("[role='menuitem']")?.querySelector("svg")).toBeTruthy();
    expect(deleteItem.closest("[role='menuitem']")?.querySelector("svg")).toBeTruthy();
    for (const item of [revealItem, copyItem, renameItem]) {
      const menuItem = item.closest("[role='menuitem']");
      expect(menuItem?.querySelector("[data-card-menu-icon-slot]")).toBeTruthy();
      expect(menuItem?.querySelector("svg")).toBeNull();
    }
  });

  it("opens the same card actions from a point anchor without a contextmenu event", async () => {
    render(
      <CardPointMenu
        block={makeBlock()}
        vaultPath="/vault"
        tags={[]}
        x={144}
        y={188}
        openRequestSequence={1}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    expect(await screen.findByText("Connect")).toBeInTheDocument();
    expect(await screen.findByText("Rename…")).toBeInTheDocument();
    expect(document.querySelector("[data-card-point-menu-anchor]")).toHaveStyle({
      left: "144px",
      top: "188px",
    });
    expect(document.querySelector("[data-slot='context-menu-content']")).not.toBeInTheDocument();
  });

  it("captures the first outside click on CardPointMenu before it reaches the app", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onAppPointerEnter = vi.fn();
    const onAppClick = vi.fn();

    render(
      <>
        <button type="button" onPointerEnter={onAppPointerEnter} onClick={onAppClick}>
          App control
        </button>
        <CardPointMenu
          block={makeBlock()}
          vaultPath="/vault"
          tags={[]}
          x={144}
          y={188}
          openRequestSequence={1}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
          onOpenChange={onOpenChange}
        />
      </>,
    );

    expect(await screen.findByText("Connect")).toBeInTheDocument();
    // No layer covers the window: the app still answers the hover.
    await user.hover(screen.getByText("App control"));
    expect(onAppPointerEnter).toHaveBeenCalled();

    await user.click(screen.getByText("App control"));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    });
    expect(onAppClick).not.toHaveBeenCalled();
  });

  it("keeps the card held by the menu it opened while the pointer goes elsewhere", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <button type="button">Elsewhere</button>
        <CardHoverMenu
          block={makeBlock()}
          vaultPath="/vault"
          tags={[]}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Card actions" }));
    expect(await screen.findByText("Rename…")).toBeInTheDocument();
    await user.hover(screen.getByText("Elsewhere"));

    // A pointer-opened menu holds the card's buttons and its bottom row,
    // which carries the lift (SPEC_CARD_STATES.md, С8).
    expect(container.querySelector("[data-card-hover-more-action]")).toHaveClass("pointer-events-auto", "opacity-100");
    expect(container.querySelector("[data-card-hover-bottom-actions]")).toHaveClass("pointer-events-auto", "opacity-100");
    expect(screen.getByText("Rename…")).toBeInTheDocument();
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

    expect(startWindowDrag).toHaveBeenCalledTimes(1);
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
