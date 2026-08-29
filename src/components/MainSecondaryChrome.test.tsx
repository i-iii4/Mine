import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MainSecondaryTopBar } from "./MainSecondaryChrome";
import type { LightBlock } from "@/types";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const BLOCK: LightBlock = {
  id: 1,
  slug: "nogal-house",
  block_type: "article",
  card_kind: "article",
  title: null,
  content_heading: null,
  display_title: "Nogal House",
  fallback_label: "nogal-house",
  url: null,
  media_file: null,
  thumbnail: null,
  saved_at: "2026-08-17T01:41:02Z",
  width: 2000,
  height: 1333,
  author: "@kotecinho",
  body: "",
  preview_text: null,
  first_image: null,
  media_urls: JSON.stringify(["a.jpg", "b.jpg", "c.jpg"]),
  media_dimensions: null,
  preview_manifest: null,
  feed_playback: null,
  search_match: null,
};

function renderBar(placement: "top" | "bottom", detailBlock: LightBlock | null) {
  return render(
    <MainSecondaryTopBar
      sidebarCollapsed={false}
      sidebarResizing={false}
      stats={null}
      detailBlock={detailBlock}
      detailTitle="Nogal House"
      detailEntered
      detailLinkMode="collections"
      onDetailLinkModeChange={vi.fn()}
      viewMode="grid"
      onViewModeChange={vi.fn()}
      vaultPath="/vault"
      tags={[]}
      currentTag={null}
      onToggleTag={vi.fn()}
      onCreateAndAssign={vi.fn()}
      onRequestRename={vi.fn()}
      onRequestDelete={vi.fn()}
      onDetailClose={vi.fn()}
      detailMenuOpenRequestSequence={0}
      placement={placement}
    />,
  );
}

describe("MainSecondaryTopBar placement", () => {
  it("closes with a border below and the window background at the top", () => {
    renderBar("top", null);

    const bar = document.querySelector("[data-main-secondary-top-bar]");
    expect(bar).toHaveClass("border-b", "bg-chrome");
    expect(bar).not.toHaveClass("border-t");
    expect(bar).toHaveAttribute("data-main-secondary-placement", "top");
  });

  it("takes the button bar's surface and a border above at the foot", () => {
    renderBar("bottom", null);

    const bar = document.querySelector("[data-main-secondary-top-bar]");
    // The seam always faces the content: below the row when it sits on top,
    // above it when it sits at the foot.
    expect(bar).toHaveClass("border-t", "bg-accent");
    expect(bar).not.toHaveClass("border-b");
  });

  it("names the open note instead of repeating its title at the foot", () => {
    renderBar("bottom", BLOCK);

    const meta = document.querySelector("[data-main-secondary-note-meta]");
    expect(meta).toBeInTheDocument();
    // The type taxonomy is gone (decision 044): no "article"/"image" atom.
    expect(meta).not.toHaveTextContent("article");
    expect(meta).toHaveTextContent("2000×1333");
    expect(meta).toHaveTextContent("3 media");
    expect(meta).toHaveTextContent("@kotecinho");
    // Title, card menu and close control belong to the top toolbar here, and
    // must not be drawn twice.
    expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeNull();
  });

  it("keeps the title, menu and close control at the top", () => {
    renderBar("top", BLOCK);

    expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeInTheDocument();
    expect(screen.getByTitle("Nogal House")).toHaveTextContent("Nogal House");
    expect(document.querySelector("[data-main-secondary-note-meta]")).toBeNull();
  });

  it("shows the collections switch over the sidebar in both placements", () => {
    const { unmount } = renderBar("bottom", BLOCK);
    expect(screen.getByText("Collections:")).toBeInTheDocument();
    unmount();

    renderBar("top", BLOCK);
    expect(screen.getByText("Collections:")).toBeInTheDocument();
  });
});
