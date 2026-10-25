import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeleteMediaAssetDialog,
  Detail,
  MediaAssetCollectionPicker,
  computeHoverPreviewPosition,
  deleteMediaFileDescription,
  detailContentFullWidth,
  hoverPreviewBounds,
} from "./Detail";
import { DETAIL_CONTENT_MAX_WIDTH_PX, detailLayout } from "@/lib/detailLayout";
import type { CardAssociationGroup, CardAssociationKind, IndexedBlock, LightBlock, MediaAssetRef } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { COLLECTION_PICKER_CONTENT_CLASS } from "./CollectionPicker";
import { ActionFailureNoticeStack } from "./ActionFailureNotices";
import { clearActionFailures } from "@/lib/actionFailures";
import { cancelSourceVideoDownload, copyMediaAssetToClipboard, getBlock, icloudDownloadProgress, listCardAssociations, prepareDeleteMediaAsset, resolveNoteLink, sourceVideoDownloadStatus, startSourceVideoDownload, youtubePlayerUrl } from "@/lib/commands";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
} from "@/lib/hoverPreviewTiming";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { indexedBlock, lightBlock } from "@/test/blocks";

/** Fake timers that also drive the hover-intent clock (performance.now). */
const INTENT_TIMERS = {
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
} satisfies Parameters<typeof vi.useFakeTimers>[0];

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

const writeText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

vi.mock("./ArticleAudioControls", () => ({
  ArticleAudioControls: () => <div data-testid="article-audio-controls" />,
}));

vi.mock("./VideoFromBlob", () => ({
  VideoFromBlob: ({
    src,
    className,
    controls,
    autoPlay,
    muted,
    loop,
    onLoadedMetadata,
  }: {
    src: string;
    className?: string;
    controls?: boolean;
    autoPlay?: boolean;
    muted?: boolean;
    loop?: boolean;
    onLoadedMetadata?: (video: HTMLVideoElement) => void;
  }) => (
    <video
      className={className}
      data-src={src}
      data-controls={controls ? "true" : "false"}
      data-autoplay={autoPlay ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-loop={loop ? "true" : "false"}
      data-testid="video-from-blob"
      onLoadedMetadata={(event) => onLoadedMetadata?.(event.currentTarget)}
    />
  ),
}));

// These tests read the open card's reading surface. A card with its whole
// body opens in the editor by default (SPEC_EDITING.md, Л1, row 50.12); the
// editor's own tests are in `editing/`, here it stays off.
vi.mock("./editing/noteEditingSwitch", async () => {
  const { createContext } = await import("react");
  return { NoteEditingSwitch: createContext(false) };
});

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(),
  copyMediaAssetToClipboard: vi.fn(),
  prepareDeleteMediaAsset: vi.fn(),
  resolveNoteLink: vi.fn(),
  icloudDownloadProgress: vi.fn(),
  youtubePlayerUrl: vi.fn(),
  startSourceVideoDownload: vi.fn(async () => null),
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

function cardKindForBlockType(blockType: IndexedBlock["block_type"]): IndexedBlock["card_kind"] {
  return blockType === "article"
    ? "article"
    : blockType === "link"
      ? "link"
    : blockType === "channel"
      ? "channel"
      : "media";
}

function block(overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  const blockType = overrides.block_type ?? "article";
  const cardKind = overrides.card_kind ?? cardKindForBlockType(blockType);
  return indexedBlock({
    id: 1,
    slug: "test-block",
    card_kind: cardKind,
    block_type: blockType,
    title: "Test Block",
    description: null,
    url: "https://example.com/article",
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
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
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
    ...overrides,
  });
}

const getBlockMock = vi.mocked(getBlock);
const copyMediaAssetToClipboardMock = vi.mocked(copyMediaAssetToClipboard);
const prepareDeleteMediaAssetMock = vi.mocked(prepareDeleteMediaAsset);
const resolveNoteLinkMock = vi.mocked(resolveNoteLink);

function renderVideoDetail(overrides: Partial<IndexedBlock> = {}) {
  const props = {
    block: block({ url: "https://www.youtube.com/watch?v=9KDDhAOyv9k", body: "# Film\n\nPreserved transcript.", thumbnail: "Media/film.jpg", ...overrides }),
    vaultPath: "/tmp/test-vault", thumbsRootPath: "/tmp/thumbs", tags: [],
    onClose: vi.fn(), onNavigate: vi.fn(), onToggleTag: vi.fn(),
    onCreateAndAssign: vi.fn(), onTagsChanged: vi.fn(), onRequestRename: vi.fn(),
    onRequestDelete: vi.fn(), onOpenRelatedNote: vi.fn(),
  };
  return { ...render(<Detail {...props} />), props };
}

const youtubePlayerUrlMock = vi.mocked(youtubePlayerUrl);

describe("Detail source video independent of card kind", () => {
  beforeEach(() => {
    youtubePlayerUrlMock.mockReset();
    youtubePlayerUrlMock.mockImplementation(async (sourceUrl) => `http://localhost:4321/youtube/${new URL(sourceUrl).searchParams.get("v") ?? new URL(sourceUrl).pathname.slice(1)}`);
  });

  it("loads the player on open next to the transcript without a play button", async () => {
    const { container } = renderVideoDetail();
    expect(screen.getByText("Preserved transcript.")).toBeInTheDocument();
    expect(container.querySelector("[data-youtube-source-player] img")?.getAttribute("src")).toContain("Media/film.jpg");
    expect(screen.queryByRole("button", { name: "Play video" })).toBeNull();
    await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4321/youtube/9KDDhAOyv9k"));
    expect(youtubePlayerUrlMock).toHaveBeenCalledWith("https://www.youtube.com/watch?v=9KDDhAOyv9k");
    expect(screen.getByText("Preserved transcript.")).toBeInTheDocument();
  });

  it("never embeds YouTube into the interface document itself", async () => {
    const { container } = renderVideoDetail();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")?.getAttribute("src")).not.toContain("youtube.com");
  });

  it("shows the poster until the local player page is ready", async () => {
    let resolve: (url: string) => void = () => {};
    youtubePlayerUrlMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { container } = renderVideoDetail();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("[data-youtube-source-player] img")).not.toBeNull();
    await act(async () => { resolve("http://localhost:4321/youtube/9KDDhAOyv9k"); });
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4321/youtube/9KDDhAOyv9k");
  });

  it("says the video cannot play inside Mine and keeps the source link when the player page fails", async () => {
    youtubePlayerUrlMock.mockRejectedValue(new Error("bind failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = renderVideoDetail();
    expect(await screen.findByText("This video can't play inside Mine.")).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Original" })).toHaveAttribute("href", "https://www.youtube.com/watch?v=9KDDhAOyv9k");
    expect(screen.getByText("Preserved transcript.")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("supports a metadata-only source link and leaves its direct source accessible on an error", async () => {
    const { container } = renderVideoDetail({ card_kind: "link", block_type: "link", body: "" });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    fireEvent.error(container.querySelector("iframe")!);
    expect(screen.getByRole("link", { name: "Open Original" })).toHaveAttribute("href", "https://www.youtube.com/watch?v=9KDDhAOyv9k");
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("retains the transcript after the external frame fails", async () => {
    const { container } = renderVideoDetail();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    fireEvent.error(container.querySelector("iframe")!);
    expect(screen.getByText("Preserved transcript.")).toBeInTheDocument();
  });

  it("gives the main local video priority over its YouTube source", () => {
    const { container } = renderVideoDetail({ media_file: "Media/film.mp4" });
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-src", expect.stringContaining("Media/film.mp4"));
    expect(screen.queryByRole("button", { name: "Play video" })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(youtubePlayerUrlMock).not.toHaveBeenCalled();
    expect(screen.getByText("Preserved transcript.")).toBeInTheDocument();
  });

  it.each([null, "Media/film.mp4"])("keeps one body video without adding a duplicate source player (%s)", (media_file) => {
    const { container } = renderVideoDetail({ media_file, body: "Transcript\n\n![[film.mp4]]", preview_manifest: JSON.stringify({
      kind: "video_poster", tiles: [{ source_path: "Media/film.mp4", is_video: true, is_video_poster: true }], overflow_count: 0,
    }) });
    expect(screen.getAllByTestId("video-from-blob")).toHaveLength(1);
    expect(container.querySelector("[data-youtube-source-player]")).toBeNull();
  });

  it("does not hide the source player for video syntax inside a code example", async () => {
    const { container } = renderVideoDetail({ body: "Example: `![](film.mp4)`" });
    await waitFor(() => expect(container.querySelector("[data-youtube-source-player] iframe")).not.toBeNull());
    expect(screen.queryByTestId("video-from-blob")).toBeNull();
  });

  it("does not treat body links or a misleading host as a source player", () => {
    const { container } = renderVideoDetail({ url: "https://youtube.com.evil.example/watch?v=9KDDhAOyv9k", body: "See [film](https://youtu.be/9KDDhAOyv9k)." });
    expect(container.querySelector("[data-youtube-source-player]")).toBeNull();
    expect(youtubePlayerUrlMock).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "film" })).toBeInTheDocument();
  });

  it("opens the source video menu on a right click with only the actions a link supports", async () => {
    const { container } = renderVideoDetail();
    fireEvent.contextMenu(container.querySelector("[data-source-video-surface]")!);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Open Original" })).toBeInTheDocument());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open Original", "Copy Link", "Download Media", "Delete Embed"]);
  });

  it("opens the source video menu as a context menu at the pointer", async () => {
    const { container } = renderVideoDetail();
    fireEvent.contextMenu(container.querySelector("[data-source-video-surface]")!, { clientX: 200, clientY: 120 });
    expect(await screen.findByRole("menu")).toHaveAttribute("data-slot", "context-menu-content");
  });

  it("opens the menu when the shell reports a right click inside the player frame, and only then", async () => {
    const { container } = renderVideoDetail();
    const surface = container.querySelector<HTMLElement>("[data-source-video-surface]")!;
    surface.getBoundingClientRect = () => ({ left: 100, top: 50, right: 740, bottom: 410, width: 640, height: 360, x: 100, y: 50, toJSON: () => ({}) });
    await act(async () => {});
    act(() => { window.dispatchEvent(new CustomEvent("source-video-context-menu", { detail: { payload: { x: 20, y: 20 } } })); });
    expect(screen.queryByRole("menuitem", { name: "Copy Link" })).toBeNull();
    act(() => { window.dispatchEvent(new CustomEvent("source-video-context-menu", { detail: { payload: { x: 300, y: 200 } } })); });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy Link" })).toBeInTheDocument());
  });

  it("copies the canonical video link", async () => {
    writeText.mockClear();
    const { container } = renderVideoDetail({ url: "https://youtu.be/9KDDhAOyv9k" });
    fireEvent.contextMenu(container.querySelector("[data-source-video-surface]")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy Link" }));
    expect(writeText).toHaveBeenCalledWith("https://www.youtube.com/watch?v=9KDDhAOyv9k");
  });

  it("deletes the source video only after confirmation", async () => {
    const onDeleteSourceVideo = vi.fn(async () => {});
    const props = {
      block: block({ url: "https://www.youtube.com/watch?v=9KDDhAOyv9k", body: "# Film\n\nPreserved transcript.", thumbnail: "Media/film.jpg" }),
      vaultPath: "/tmp/test-vault", thumbsRootPath: "/tmp/thumbs", tags: [],
      onClose: vi.fn(), onNavigate: vi.fn(), onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(), onTagsChanged: vi.fn(), onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(), onOpenRelatedNote: vi.fn(), onDeleteSourceVideo,
    };
    const { container } = render(<Detail {...props} />);
    fireEvent.contextMenu(container.querySelector("[data-source-video-surface]")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Embed" }));
    expect(await screen.findByText("Delete embed from element?")).toBeInTheDocument();
    expect(onDeleteSourceVideo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete embed" }));
    await waitFor(() => expect(onDeleteSourceVideo).toHaveBeenCalledWith(props.block.slug));
    await waitFor(() => expect(screen.queryByText("Delete embed from element?")).toBeNull());
  });

  describe("Download Media", () => {
    const sendDownload = (payload: Record<string, unknown>) => act(() => {
      window.dispatchEvent(new CustomEvent("source-video-download", { detail: { payload } }));
    });

    function renderWithDownloadHandler() {
      const onSourceVideoDownloaded = vi.fn(async () => {});
      const props = {
        block: block({ url: "https://www.youtube.com/watch?v=9KDDhAOyv9k", body: "# Film\n\nPreserved transcript.", thumbnail: "Media/film.jpg" }),
        vaultPath: "/tmp/test-vault", thumbsRootPath: "/tmp/thumbs", tags: [],
        onClose: vi.fn(), onNavigate: vi.fn(), onToggleTag: vi.fn(),
        onCreateAndAssign: vi.fn(), onTagsChanged: vi.fn(), onRequestRename: vi.fn(),
        onRequestDelete: vi.fn(), onOpenRelatedNote: vi.fn(), onSourceVideoDownloaded,
      };
      return { ...render(<Detail {...props} />), props, onSourceVideoDownloaded };
    }

    beforeEach(() => {
      vi.mocked(startSourceVideoDownload).mockClear();
      vi.mocked(cancelSourceVideoDownload).mockClear();
      vi.mocked(sourceVideoDownloadStatus).mockReset();
      vi.mocked(sourceVideoDownloadStatus).mockResolvedValue(null);
    });

    it("starts from the menu and shows progress under the player, not over it", async () => {
      const { container, props } = renderWithDownloadHandler();
      await act(async () => {});
      fireEvent.contextMenu(container.querySelector("[data-source-video-surface]")!);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Download Media" }));
      expect(startSourceVideoDownload).toHaveBeenCalledWith(props.block.slug, "https://www.youtube.com/watch?v=9KDDhAOyv9k");
      // Reading formats has no known length: an indeterminate bar, cancellable.
      expect(await screen.findByText("Preparing…")).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("data-progress-mode", "indeterminate");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(container.querySelector("[data-source-video-surface] [data-source-video-download]")).toBeNull();
      sendDownload({ slug: props.block.slug, state: "downloading", percent: 0 });
      expect(screen.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("data-progress-mode", "determinate");
      sendDownload({ slug: props.block.slug, state: "downloading", percent: 42 });
      expect(screen.getByText("Downloading 42%")).toBeInTheDocument();
      sendDownload({ slug: "another card", state: "downloading", percent: 90 });
      expect(screen.getByText("Downloading 42%")).toBeInTheDocument();
      sendDownload({ slug: props.block.slug, state: "finishing" });
      expect(screen.getByText("Joining video and sound…")).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("data-progress-mode", "indeterminate");
      // The join can be cancelled too (SPEC_AUDIT_FIXES.md, А7.5).
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("reloads the card once the file is in the space", async () => {
      const { props, onSourceVideoDownloaded } = renderWithDownloadHandler();
      await act(async () => {});
      sendDownload({ slug: props.block.slug, state: "done" });
      await waitFor(() => expect(onSourceVideoDownloaded).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(/Downloading/)).toBeNull();
    });

    it("cancels a running download and says why one failed", async () => {
      const { props } = renderWithDownloadHandler();
      await act(async () => {});
      sendDownload({ slug: props.block.slug, state: "downloading", percent: 10 });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(cancelSourceVideoDownload).toHaveBeenCalledWith(props.block.slug);
      sendDownload({ slug: props.block.slug, state: "cancelled" });
      expect(screen.queryByText(/Downloading/)).toBeNull();
      sendDownload({ slug: props.block.slug, state: "failed", message: "YouTube refused the download. Try again later." });
      expect(screen.getByText("YouTube refused the download. Try again later.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    });

    it("shows a download that is still running when the card is opened again", async () => {
      vi.mocked(sourceVideoDownloadStatus).mockResolvedValue({ state: "downloading", percent: 64 });
      renderWithDownloadHandler();
      expect(await screen.findByText("Downloading 64%")).toBeInTheDocument();
    });

    it("does not start a second download while one runs", async () => {
      const { container, props } = renderWithDownloadHandler();
      await act(async () => {});
      sendDownload({ slug: props.block.slug, state: "downloading", percent: 5 });
      fireEvent.contextMenu(container.querySelector("[data-source-video-surface]")!);
      expect(await screen.findByRole("menuitem", { name: "Download Media" })).toHaveAttribute("data-disabled");
    });
  });

  it("loads the next video's player when navigation changes video identity", async () => {
    const { container, rerender, props } = renderVideoDetail();
    await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4321/youtube/9KDDhAOyv9k"));
    rerender(<Detail {...props} block={block({ slug: "next", url: "https://youtu.be/abcdefghijk", body: "Second transcript" })} />);
    expect(screen.getByText("Second transcript")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4321/youtube/abcdefghijk"));
  });
});

function setViewportWidth(value: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value,
  });
}

describe("deleteMediaFileDescription", () => {
  const reference = (kinds: string[]) => ({
    slug: "Card",
    title: "Card",
    display_title: "Card",
    fallback_label: "Card",
    card_kind: "media" as const,
    reference_kinds: kinds,
  });
  const cleared =
    "The file goes to the Trash. Its references are removed from the elements below and do not come back if you restore the file.";

  // DESIGN_SYSTEM.md, «Тексты окон», `Delete media file?`.
  it("says only the Trash while the elements are unknown or absent", () => {
    expect(deleteMediaFileDescription(null)).toBe("The file goes to the Trash.");
    expect(deleteMediaFileDescription([])).toBe("The file goes to the Trash.");
  });

  it("says the references do not come back when elements use the file", () => {
    expect(deleteMediaFileDescription([reference(["body_embed"]), reference(["frontmatter_thumbnail"])]))
      .toBe(cleared);
  });

  it("warns that an element showing it as main media shows nothing", () => {
    expect(deleteMediaFileDescription([reference(["body_embed"]), reference(["frontmatter_file", "body_embed"])]))
      .toBe(`${cleared} Elements that show it as their main media will show nothing in its place.`);
  });
});

describe("Detail", () => {
  const initialViewportWidth = window.innerWidth;

  beforeEach(() => {
    getBlockMock.mockReset();
    getBlockMock.mockResolvedValue(null);
    resolveNoteLinkMock.mockReset();
    resolveNoteLinkMock.mockResolvedValue(null);
    copyMediaAssetToClipboardMock.mockReset();
    copyMediaAssetToClipboardMock.mockResolvedValue(undefined);
    vi.mocked(icloudDownloadProgress).mockReset();
    vi.mocked(icloudDownloadProgress).mockResolvedValue({ status: "unknown", percent: null });
    prepareDeleteMediaAssetMock.mockReset();
    prepareDeleteMediaAssetMock.mockResolvedValue({
      media_ref: "photo.jpg",
      media_kind: "image",
      canvases: [],
      referenced_by: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setViewportWidth(initialViewportWidth);
  });

  it.each([false, true])("uses the resolved deletion path and never reports empty references after an error (%s)", async (failure) => {
    if (failure) prepareDeleteMediaAssetMock.mockRejectedValueOnce({ kind: "media_not_found", media_ref: "photo.jpg" });
    else prepareDeleteMediaAssetMock.mockResolvedValueOnce({ media_ref: "Media/photo.jpg", media_kind: "image", referenced_by: [], canvases: [] });
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Detail
      block={block({ card_kind: "media", block_type: "image", media_file: "photo.jpg", url: null })}
      vaultPath="/tmp/fixture" thumbsRootPath="/tmp/thumbs" tags={[]}
      onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
      onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()}
      onDeleteMediaAsset={onDelete} onOpenRelatedNote={vi.fn()} />);
    const trigger = container.querySelector("[data-detail-media-more-button]")!;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Delete Media"));
    const dialog = await screen.findByRole("alertdialog");
    if (failure) {
      expect(await within(dialog).findByText("Media file was not found.")).toBeInTheDocument();
      expect(within(dialog).queryByText("No elements use this file.")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Delete media" })).toBeDisabled();
      expect(onDelete).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete media" })).toBeEnabled());
      // No element uses the file: only its own fate is said.
      expect(dialog).toHaveAccessibleDescription("The file goes to the Trash.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete media" }));
      await waitFor(() => expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ media_ref: "Media/photo.jpg" })));
    }
  });

  it.each([
    [{ slug: "Cards/Шуховская башня", media_file: null }, "Шуховская башня.md", "Cards/Шуховская башня.md"],
    [{ slug: "Cards/Amelia", media_file: "Media/Amelia Watt.jpg" }, "Amelia Watt.jpg", "Media/Amelia Watt.jpg"],
    [{ slug: "Flat card", media_file: null }, "Flat card.md", "Flat card.md"],
  ])("names the file in the header and keeps its folder for the hint: %o", (overrides, name, path) => {
    const { container } = render(<Detail
      block={block({ ...overrides, url: null })}
      vaultPath="/tmp/fixture" thumbsRootPath="/tmp/thumbs" tags={[]}
      onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
      onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()} />);
    const header = container.querySelector("[data-detail-card-name]")!;
    expect(header).toHaveTextContent(name);
    expect(header.textContent).toBe(name);
    expect(header).toHaveAttribute("title", path);
  });

  it("renders the classic top menu", () => {
    const props = {
      block: block(),
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
      onOpenRelatedNote: vi.fn(),
    };

    const { container } = render(<Detail {...props} />);

    const topMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(topMenu).not.toBeNull();
    expect(topMenu).toHaveClass("detail-top-bar-enter");
    expect(topMenu).toHaveClass("chrome-row", "bg-accent", "pl-[var(--chrome-edge-pad)]");
    expect(topMenu?.nextElementSibling).toHaveAttribute("data-chrome-divider");
    expect(topMenu?.querySelectorAll('[data-size="chrome-icon"]')).toHaveLength(2);
  });

  it("toggles the classic top overflow menu with Command-K", async () => {
    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByText("Rename…")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
    });
  });

  it("does not mount article audio controls while the feature is off", () => {
    render(
      <Detail
        block={block({ body: "# Heading\n\nSpoken prose would go here." })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    // ARTICLE_AUDIO_ENABLED is false: the implementation stays in the tree but
    // nothing renders it. Flip the flag and this assertion is what fails first.
    expect(screen.queryByTestId("article-audio-controls")).not.toBeInTheDocument();
  });

  it("names the detail dialog with the active filename", () => {
    render(
      <Detail
        block={block({ media_file: "article-cover.jpg" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "article-cover.jpg" })).toBeInTheDocument();
  });

  it("keeps classic top chrome mounted and entered when switching active cards", async () => {
    const props = {
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
      onOpenRelatedNote: vi.fn(),
    };

    const { container, rerender } = render(
      <Detail
        {...props}
        block={block({ slug: "first-card", media_file: "first-card.jpg" })}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-detail-top-menu="classic"]')).toHaveAttribute(
        "data-entered",
        "true",
      );
    });

    const topMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(topMenu).toHaveTextContent("first-card.jpg");

    rerender(
      <Detail
        {...props}
        block={block({ slug: "second-card", media_file: "second-card.jpg" })}
      />,
    );

    await waitFor(() => {
      expect(topMenu).toHaveTextContent("second-card.jpg");
    });
    expect(container.querySelector('[data-detail-top-menu="classic"]')).toBe(topMenu);
    expect(topMenu).toHaveAttribute("data-entered", "true");
  });

  it("does not close Detail when Escape belongs to a nested menu surface", () => {
    const onClose = vi.fn();
    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={onClose}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);

    fireEvent.keyDown(menu, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    menu.remove();
  });

  it("does not navigate cards with arrow keys in Detail view", () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={onClose}
        onNavigate={onNavigate}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("animates the classic header and its separator as separate chrome layers", () => {
    const { container } = render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const classicMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(classicMenu).toHaveClass("detail-top-bar-enter");
    expect(classicMenu).not.toHaveClass("border-b");
    const line = classicMenu?.nextElementSibling;
    expect(line).toHaveClass("detail-top-bar-line-enter");
    expect(line).toHaveClass("bg-border");
  });

  it("reverses the top chrome enter state while closing", () => {
    const props = {
      block: block(),
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
      onOpenRelatedNote: vi.fn(),
    };

    const { container, rerender } = render(<Detail {...props} />);

    rerender(<Detail {...props} isClosing />);

    const classicMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(classicMenu).toHaveAttribute("data-entered", "false");
    expect(classicMenu?.nextElementSibling).toHaveAttribute(
      "data-entered",
      "false",
    );
  });

  it("keeps bottom safe space inside the scroll content", () => {
    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const scrollEl = container.querySelector("[data-detail-scroll]");
    expect(scrollEl).not.toHaveClass("pb-20");
    // Beside the panel the grid carries it; stacked, the panel's band does,
    // so the band's fill reaches the bottom.
    const grid = scrollEl?.firstElementChild;
    const stackedBand = grid?.querySelector("[data-detail-stacked-metadata-row]");
    expect(stackedBand ?? grid).toHaveClass("pb-20");
  });

  it("shows article author only in metadata, not above the opened article body", () => {
    render(
      <Detail
        block={block({
          author: "Author Name",
          body: "# Heading\n\nArticle body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Author")).toBeInTheDocument();
    expect(screen.getAllByText("Author Name")).toHaveLength(1);
  });

  // SPEC_READING_MODE.md, Ч11.8: a card opened by `Note#Heading` or
  // `Note#^block` scrolls its article to that place, once.
  it("opens scrolled to the heading or the block its link names, and stays when the body is written", async () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    const props = {
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
      onOpenRelatedNote: vi.fn(),
    };
    const body = "Intro [[Peer]]\n\n## Plan: A/B\n\nText ^c0ffee\n\n### Steps\n\n- [ ] task";
    scrollIntoView.mockClear();
    const { rerender } = render(<Detail {...props} block={block({ slug: "Cards/Source", body })} scrollAnchor="Plan A B#Steps" />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect((scrollIntoView.mock.contexts[0] as Element).textContent).toBe("Steps");
    // A body written later (a task box) does not jump again.
    rerender(<Detail {...props} block={block({ slug: "Cards/Source", body: body.replace("[ ]", "[x]") })} scrollAnchor="Plan A B#Steps" />);
    await act(async () => { await new Promise((done) => window.setTimeout(done, 30)); });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<Detail {...props} block={block({ slug: "Cards/Source", body })} scrollAnchor="^C0FFEE" />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect((scrollIntoView.mock.contexts[1] as Element).textContent).toBe("Text ^c0ffee");
    // A place the note has not leaves the card at its top.
    rerender(<Detail {...props} block={block({ slug: "Cards/Source", body })} scrollAnchor="Missing" />);
    await act(async () => { await new Promise((done) => window.setTimeout(done, 30)); });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("opens nested note wikilinks through source resolution and leaves external links external", async () => {
    resolveNoteLinkMock.mockResolvedValue("Notes/Peer");
    const onOpenRelatedNote = vi.fn();
    render(
      <Detail
        block={block({ slug: "Cards/Source", body: "See [[Peer#Heading|my peer]] and [external](https://example.org)" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "my peer" }));
    await waitFor(() => expect(onOpenRelatedNote).toHaveBeenCalledWith("Notes/Peer"));
    expect(resolveNoteLinkMock).toHaveBeenCalledWith("Cards/Source", "Peer#Heading");
    const external = screen.getByRole("link", { name: "external" });
    expect(external).toHaveAttribute("href", "https://example.org");
    expect(external).toHaveAttribute("target", "_blank");
    fireEvent.click(external);
    expect(resolveNoteLinkMock).toHaveBeenCalledTimes(1);
  });

  it("does not navigate an unresolved wikilink", async () => {
    const onOpenRelatedNote = vi.fn();
    render(
      <Detail
        block={block({ slug: "Cards/Source", body: "[[Missing]]" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );
    expect(fireEvent.click(screen.getByRole("link", { name: "Missing" }))).toBe(false);
    await waitFor(() => expect(resolveNoteLinkMock).toHaveBeenCalledWith("Cards/Source", "Missing"));
    expect(onOpenRelatedNote).not.toHaveBeenCalled();
  });

  it("truncates identifier metadata values instead of wrapping them", () => {
    render(
      <Detail
        block={block({
          author: "@meanwhile_really_long_handle",
          body: "Article body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("@meanwhile_really_long_handle")).toHaveClass(
      "min-w-0",
      "truncate",
    );
    expect(screen.getByText("@meanwhile_really_long_handle")).toHaveAttribute(
      "title",
      "@meanwhile_really_long_handle",
    );
  });

  it("wraps warning metadata while keeping the shared rail layout", () => {
    render(
      <Detail
        block={block({
          body: "Article body",
          index_warning: "malformed_frontmatter",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Malformed frontmatter, shown as Markdown")).toHaveClass(
      "min-w-0",
      "break-words",
      "[overflow-wrap:anywhere]",
    );
  });

  it("renders metadata as a shared two-column grid", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "Article body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const metadataTable = container.querySelector("[data-metadata-table]");
    expect(metadataTable).toHaveClass("w-full");

    const dateLabel = screen.getByText("Date");
    expect(dateLabel).toHaveClass("font-mono", "text-sm", "leading-4");
    expect(dateLabel).not.toHaveClass("font-semibold", "uppercase", "tracking-widest");
    expect(dateLabel).toHaveClass("whitespace-nowrap");
    expect(dateLabel.closest("[data-metadata-row]")?.tagName).toBe("DIV");
    // A row of the box's surface: 32 px, its line centered, the separator
    // on its bottom edge.
    expect(dateLabel.closest("[data-metadata-row]")).toHaveClass(
      "relative",
      "grid",
      "w-full",
      "grid-cols-[max-content_minmax(0,1fr)]",
      "gap-x-4",
      "py-plate",
      "after:bottom-0",
      "after:border-border",
    );
    expect(dateLabel.closest("[data-metadata-row]")).toHaveAttribute("data-metadata-row-spacing", "row");
    const metadataRows = container.querySelectorAll("[data-metadata-row]");
    expect(metadataRows.length).toBeGreaterThan(0);
    expect(dateLabel.closest("[data-metadata-row]")?.lastElementChild?.firstElementChild).toHaveClass(
      "text-sm",
      "leading-4",
    );
  });

  it("uses one detail canvas grid for content spacer and fixed rail", () => {
    // Wide enough for the 680px reading column, the 320px panel, the line
    // before it and four 32px insets (1129px).
    setViewportWidth(1400);
    const { container } = render(
      <Detail
        block={block({
          body: "Article body",
          author: "@meanwhile_really_long_handle",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const rail = container.querySelector("[data-metadata-scroll]");
    const panelColumn = container.querySelector("[data-detail-panel-column]");
    const articleColumn = container.querySelector("[data-detail-article-column]");
    expect(articleColumn).toHaveClass("col-start-2", "min-w-0");
    expect(articleColumn).not.toHaveClass("pl-2", "pl-4");
    expect(panelColumn).toHaveClass("col-start-4", "min-w-0");
    expect(rail?.parentElement).toBe(panelColumn);
    expect(rail).toHaveClass("min-h-0", "overflow-y-auto", "overflow-x-hidden");
    const spacer = container.querySelector("[data-detail-metadata-spacer]");
    expect(spacer).toHaveClass("col-start-4", "min-w-0");
    // The content's column is its full width; the panel never narrows it.
    const columns = "minmax(var(--card-content-pad),1fr) 680px minmax(var(--card-content-pad),1fr) calc(321px + 2 * var(--card-content-pad))";
    const scrollGrid = spacer?.parentElement;
    const panelGrid = panelColumn?.parentElement;
    for (const grid of [scrollGrid, panelGrid]) {
      expect(grid).toHaveClass("w-full", "grid");
      expect((grid as HTMLElement).style.gridTemplateColumns).toBe(columns);
    }
    expect(scrollGrid).toHaveClass("pt-[var(--card-content-pad)]");
    // One row as tall as the open card bounds the panel's own scroll (Р8).
    expect(panelGrid).toHaveClass("h-full", "grid-rows-[minmax(0,1fr)]");
  });

  it("scrolls the panel beside the content on its own, with the content's band and bottom space (Р8)", async () => {
    // The band is a dark-theme treatment; jsdom resolves to light by default.
    document.documentElement.setAttribute("data-theme", "dark");
    setViewportWidth(1400);
    const { container, unmount } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
        scrollEdgeFade
      />,
    );
    try {
      const rail = container.querySelector("[data-metadata-scroll]") as HTMLElement;
      // The same insets as the content's scroll, inside it.
      expect(rail.firstElementChild).toHaveClass("pt-[var(--card-content-pad)]", "pb-20");
      // Above the content's band: each band fades only its own surface.
      expect(container.querySelector("[data-detail-fixed-metadata-layer]")).toHaveClass("z-10");
      const scrim = container.querySelector('[data-top-fade-scrim="detail-panel"]') as HTMLElement;
      // A sibling of the panel's scroll, never inside it.
      expect(scrim.parentElement).toBe(rail.parentElement);
      expect(rail.contains(scrim)).toBe(false);
      expect(scrim.dataset.topFadeVisible).toBe("false");

      rail.scrollTop = 120;
      fireEvent.scroll(rail);

      await waitFor(() => expect(scrim.dataset.topFadeVisible).toBe("true"));
      expect(rail).toHaveAttribute("data-detail-panel-top-fade", "true");
      // The content did not move: its band stays at rest.
      expect(container.querySelector('[data-top-fade-scrim="detail"]')).toHaveAttribute("data-top-fade-visible", "false");
    } finally {
      // Unmounted first, so the theme's change reaches no mounted surface.
      unmount();
      document.documentElement.removeAttribute("data-theme");
    }
  });

  it("stacks at once when the full-width content, the panel, its line and four insets do not fit", async () => {
    setViewportWidth(1095);

    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-detail-layout-mode]")).toHaveAttribute(
        "data-detail-layout-mode",
        "stacked",
      );
    });

    const scrollGrid = container.querySelector('[data-detail-layout-grid="scroll"]');
    const articleColumn = container.querySelector("[data-detail-article-column]");
    const stackedMetadataRow = container.querySelector("[data-detail-stacked-metadata-row]");

    expect(scrollGrid).toHaveClass(
      "grid-cols-[var(--card-content-pad)_minmax(0,1fr)_var(--card-content-pad)]",
      "pt-[var(--card-content-pad)]",
      "min-h-full",
    );
    expect(scrollGrid).not.toHaveClass("pb-20");
    // Content centred at its full width; the panel's cards under it centred
    // and no wider than the reading column, in a narrower window across the
    // width between the insets (Р4).
    expect(articleColumn).toHaveClass("col-start-2", "mx-auto", "w-full");
    expect((articleColumn as HTMLElement).style.maxWidth).toBe("680px");
    // The band runs the card's width under a line, an inset on either side
    // of it, the bottom space inside it.
    expect(stackedMetadataRow).toHaveClass(
      "col-span-full",
      "border-t",
      "mt-[var(--card-content-pad)]",
      "pt-[var(--card-content-pad)]",
      "px-[var(--card-content-pad)]",
      "pb-20",
    );
    const stackedPanel = container.querySelector("[data-detail-stacked-panel]") as HTMLElement;
    expect(stackedPanel).toHaveClass("mx-auto", "w-full", "min-w-0");
    expect(stackedPanel.style.maxWidth).toBe(`${DETAIL_CONTENT_MAX_WIDTH_PX}px`);
    expect(container.querySelector("[data-detail-fixed-metadata-layer]")).toBeNull();
    expect(container.querySelector("[data-detail-metadata-spacer]")).toBeNull();
  });

  it("holds the stacked panel's cards to the reading column, not to a narrower picture (Р4)", async () => {
    // A picture 880 × 1100 under the 85vh limit is narrower than the column,
    // so it stacks below 3 × 32 + its width + 320.
    setViewportWidth(900);
    const { container } = render(
      <Detail
        block={block({ card_kind: "media", block_type: "image", media_file: "Media/p.jpg", url: null, width: 880, height: 1100 })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-detail-layout-mode]")).toHaveAttribute("data-detail-layout-mode", "stacked");
    });
    const contentWidth = Number(container.querySelector("[data-detail-content-width]")?.getAttribute("data-detail-content-width"));
    expect(contentWidth).toBeLessThan(DETAIL_CONTENT_MAX_WIDTH_PX);
    const articleColumn = container.querySelector("[data-detail-article-column]") as HTMLElement;
    const stackedPanel = container.querySelector("[data-detail-stacked-panel]") as HTMLElement;
    expect(articleColumn.style.maxWidth).toBe(`${contentWidth}px`);
    expect(stackedPanel.style.maxWidth).toBe(`${DETAIL_CONTENT_MAX_WIDTH_PX}px`);
  });

  it("keeps the content beside the panel up to the last pixel that fits", () => {
    setViewportWidth(1129);
    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-detail-layout-mode]")).toHaveAttribute("data-detail-layout-mode", "rail");
  });

  it("takes a lone picture's own size as the content's full width", () => {
    const picture = block({ card_kind: "media", block_type: "image", media_file: "Media/p.jpg", width: 880, height: 1100 });
    // Natural width under the column, and short of the 85vh limit.
    expect(detailContentFullWidth({ ...picture, width: 600, height: 400 }, 1000)).toBe(600);
    // The 85vh limit: 0.85 × 800 × 880 / 1100 = 544.
    expect(detailContentFullWidth(picture, 800)).toBe(544);
    // Never wider than the reading column, 680 (user's decision of
    // 16.10.2026: 680 instead of 768).
    expect(detailContentFullWidth({ ...picture, width: 4000, height: 1000 }, 1000)).toBe(680);
    // Text keeps the reading column whatever its size.
    expect(detailContentFullWidth(block({ body: "Article body" }), 400)).toBe(680);
    // The stacking rule: 4 × pad + content + line + 320.
    expect(detailLayout(4 * 16 + 544 + 321, 16, 544).mode).toBe("rail");
    expect(detailLayout(4 * 16 + 544 + 320, 16, 544).mode).toBe("stacked");
  });

  it("takes a lone video's frame width as the content's full width, and keeps the column for a video with text", () => {
    const clip = block({ card_kind: "media", block_type: "video", url: null, media_file: "Media/clip.mp4", width: 1080, height: 1920 });
    // Portrait at the height limit: 0.85 × 800 × 1080 / 1920 = 382.5.
    expect(detailContentFullWidth(clip, 800)).toBe(383);
    // Its tile in the manifest is the video's size.
    const tiled = {
      ...clip,
      width: null,
      height: null,
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "Cards/clip.jpg",
        tiles: [{ source_path: "Media/clip.mp4", preview_path: "Cards/clip.jpg", width: 720, height: 720, is_video: true, is_video_poster: true }],
      }),
    };
    expect(detailContentFullWidth(tiled, 800)).toBe(680);
    // Text under the video: the reading column.
    expect(detailContentFullWidth({ ...clip, body: "A caption under the clip." }, 800)).toBe(680);
    // Without a recorded size: the column, the frame learns the size inside it.
    expect(detailContentFullWidth({ ...clip, width: null, height: null }, 800)).toBe(680);
    // The YouTube player keeps its column.
    expect(detailContentFullWidth(block({ card_kind: "media", block_type: "video", url: "https://www.youtube.com/watch?v=9KDDhAOyv9k", width: 1080, height: 1920 }), 800)).toBe(680);
  });

  it("keeps a related note's card preview inside the open card's area", () => {
    // The open card right of a 314px sidebar in a 1000 × 900 window.
    const area = { left: 314, top: 0, right: 1000, bottom: 900 };
    // Beside the panel's row: room on the left, the preview opens there.
    expect(computeHoverPreviewPosition({ left: 664, right: 984, top: 221, bottom: 265 }, 306, area))
      .toEqual({ left: 664 - 8 - 240, top: 221 });
    // Stacked: the row spans the column, no room on either side within the
    // area. The preview used to open left at 103 and lie 211px under the
    // sidebar (07.10.2026); it now stands over the row, its right edge on
    // the row's right edge (08.10.2026).
    expect(computeHoverPreviewPosition({ left: 351, right: 963, top: 744, bottom: 788 }, 306, area))
      .toEqual({ left: 963 - 240, top: 744 - 8 - 306 });
    // Under the row when there is room below.
    expect(computeHoverPreviewPosition({ left: 351, right: 963, top: 200, bottom: 244 }, 306, area))
      .toEqual({ left: 963 - 240, top: 244 + 8 });
    // A row narrower than the preview: the area's left margin holds it in.
    expect(computeHoverPreviewPosition({ left: 330, right: 500, top: 200, bottom: 244 }, 306, { ...area, right: 520 }))
      .toEqual({ left: 314 + 16, top: 244 + 8 });
    // A row outside an open card (a dialog) has the whole window.
    expect(hoverPreviewBounds(document.body)).toEqual({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  });

  it("compensates classic detail chrome so article and rail start at the 64px detail inset", () => {
    setViewportWidth(1400);
    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const articleColumn = container.querySelector("[data-detail-article-column]");
    const rail = container.querySelector("[data-metadata-scroll]");
    // Side columns and top offset follow the app-wide edge rhythm setting.
    expect(articleColumn?.parentElement).toHaveClass("pt-[var(--card-content-pad)]");
    expect(rail?.firstElementChild).toHaveClass("pt-[var(--card-content-pad)]");
  });

  it("packs related notes into a card of the panel like the metadata card", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "Related Note Title",
          display_title: "Related Note Title",
          title: null,
          related_notes: [],
        });
      }
      return null;
    });

    render(
      <Detail
        block={block({ related_notes: ["related-note"] })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await waitFor(() => {
      const label = screen.getByText("Related notes");
      expect(label.closest("[data-metadata-row]")).toBeNull();
      // A row of the card at its top, the text at the metadata labels'
      // inset across and down.
      expect(label).toHaveClass("font-mono", "text-muted-foreground", "flex", "h-row", "items-center", "px-surface");
      const relatedCard = label.parentElement;
      expect(relatedCard).toHaveAttribute("data-related-notes-block");
      expect(relatedCard?.parentElement).toHaveAttribute("data-metadata-sections");
      expect(relatedCard?.parentElement).toHaveClass("gap-[var(--edge-rhythm,32px)]");
      // One card shell for both: the two cannot drift apart.
      const metadataCard = document.querySelector("[data-detail-metadata-card]");
      expect(relatedCard).toHaveAttribute("data-detail-panel-card");
      expect(metadataCard).toHaveAttribute("data-detail-panel-card");
      expect(relatedCard?.className).toBe(metadataCard?.className);
      expect(relatedCard).toHaveStyle({ minWidth: "240px" });
      // The card holds its rows at the surface's inset; the rows stand flush
      // and pad the plate's inset, so thumbnails meet the labels' vertical.
      expect(relatedCard).toHaveClass("p-surface");
      const list = relatedCard?.querySelector("[data-related-notes-list]");
      expect(list).not.toHaveClass("p-1");
      expect(list?.querySelector("[data-card-row] > button")).toHaveClass("h-card-row", "pl-card-thumb-inset", "pr-plate");
    });
  });

  it("places the detail action row between metadata and related notes with intrinsic button widths", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          fallback_label: "Related Note",
          related_notes: [],
        });
      }
      return null;
    });

    const { container } = render(
      <Detail
        block={block({ related_notes: ["related-note"] })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-related-note-item="button"]')).not.toBeNull();
    });

    const sections = container.querySelector("[data-metadata-sections]");
    const actionRow = container.querySelector("[data-detail-action-row]");
    const relatedNotesBlock = container.querySelector("[data-related-notes-block]");
    expect(sections).toHaveClass("gap-[var(--edge-rhythm,32px)]");
    // Buttons on the box: 8 px off the frame (its 4 and their own 4), 4 off
    // each other and off the row above.
    expect(actionRow).toHaveClass(
      "min-w-0",
      "flex",
      "items-center",
      "gap-surface",
      "m-surface",
    );
    expect(actionRow).not.toHaveClass("px-2", "pb-2");
    const metadataCard = actionRow?.closest("[data-detail-metadata-card]");
    expect(metadataCard?.querySelector("[data-metadata-table]")).not.toBeNull();
    expect(metadataCard?.nextElementSibling).toBe(relatedNotesBlock);

    const sourceButton = screen.getByRole("button", { name: /Source/i });
    const connectButton = screen.getByRole("button", { name: /Connect/i });
    expect(sourceButton).toHaveClass("min-w-0", "flex-1", "bg-depth-fill");
    expect(connectButton).toHaveClass("min-w-0", "flex-1", "bg-depth-fill");
    expect(sourceButton).not.toHaveClass("w-full");
    expect(connectButton).not.toHaveClass("w-full");
    expect(screen.queryByRole("button", { name: /More/i })).not.toBeInTheDocument();
  });

  it("frames metadata and detail actions with the shared card radius", () => {
    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const metadataCard = container.querySelector("[data-detail-metadata-card]");
    expect(metadataCard).toHaveClass(
      "overflow-hidden",
      "rounded-[var(--radius-card)]",
      "border",
      "border-border",
      "bg-card",
      "p-surface",
    );
    expect(metadataCard).toHaveStyle({ minWidth: "240px" });
    const metadataContent = metadataCard?.querySelector("[data-detail-metadata-card-content]");
    expect(metadataContent).toHaveClass("px-surface");
    expect(metadataContent).not.toHaveClass("pt-4", "pb-4");
    expect(metadataCard?.querySelector("[data-metadata-table]")).not.toBeNull();
    expect(metadataCard?.querySelector("[data-detail-action-row]")).not.toBeNull();
  });

  it("keeps a stable top inset for article content after author removal", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "# Heading\n\nArticle body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const articleBody = container.querySelector("[data-article-body]");
    expect(articleBody).toHaveClass(
      "prose",
      "prose-sm",
      "max-w-none",
      "[&>:first-child]:mt-0",
      "[&>:last-child]:mb-0",
      "[&_p]:leading-5",
      "[&_li]:leading-5",
    );
  });

  it("does not attach Mine behavior to native selected-text drag", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "Alpha beta gamma",
          body_hash: "body-hash-1",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const article = container.querySelector<HTMLElement>("[data-article-body]");
    const paragraph = article?.querySelector("p");
    const textNode = paragraph?.firstChild;
    expect(article).not.toHaveAttribute("role", "button");
    expect(textNode?.textContent).toBe("Alpha beta gamma");

    const range = document.createRange();
    range.setStart(textNode!, "Alpha ".length);
    range.setEnd(textNode!, "Alpha beta".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.dragStart(paragraph!);
    expect(article).not.toHaveAttribute("data-dnd-kit-draggable");
    expect(screen.queryByRole("button", {
      name: "Drag selected text to a collection",
    })).not.toBeInTheDocument();
    selection?.removeAllRanges();
  });

  it("shows selected text actions without hijacking article pointer input", async () => {
    const onTextSelectionDrop = vi.fn();
    const onTextSelectionDelete = vi.fn();
    const { container } = render(
      <Detail
        block={block({
          body: "Alpha beta gamma",
          body_hash: "body-hash-1",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        onTextSelectionDrop={onTextSelectionDrop}
        onTextSelectionDelete={onTextSelectionDelete}
      />,
    );

    const paragraph = container.querySelector("p")!;
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, "Alpha ".length);
    range.setEnd(textNode, "Alpha beta".length);
    Object.defineProperty(range, "getClientRects", {
      value: vi.fn(() => [
        { left: 40, right: 140, top: 20, bottom: 40, width: 100, height: 20 },
      ]),
    });
    Object.defineProperty(paragraph, "getBoundingClientRect", {
      value: vi.fn(() => ({ left: 40, right: 200, top: 20, bottom: 40, width: 160, height: 20 })),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const row = document.createElement("div");
    row.dataset.sidebarTextDropTag = "alpha";
    document.body.appendChild(row);
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => row),
    });

    document.dispatchEvent(new Event("selectionchange"));
    const handle = await screen.findByRole("button", {
      name: "Drag selected text to a collection",
    });
    expect(handle).toBeInTheDocument();
    const actionBar = document.querySelector("[data-text-selection-action-bar]") as HTMLElement;
    expect(actionBar).toBeTruthy();
    expect(actionBar.parentElement).toBe(document.body);
    const createButton = within(actionBar).getByRole("button", { name: "Create Element" });
    const deleteButton = within(actionBar).getByRole("button", { name: "Delete Text" });
    const clearButton = within(actionBar).getByRole("button", { name: "Clear text selection" });
    expect(createButton.querySelector("svg")).toBeTruthy();
    expect(deleteButton.querySelector("svg")).toBeTruthy();
    expect(clearButton.querySelector("svg")).toBeTruthy();

    fireEvent.pointerDown(paragraph, {
      button: 0,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });

    expect(row).not.toHaveAttribute("data-selected-text-over");

    fireEvent.pointerUp(window, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });

    expect(onTextSelectionDrop).not.toHaveBeenCalled();

    fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
    const pickerSearch = await screen.findByPlaceholderText("Search collections...");
    selection?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    fireEvent.focus(pickerSearch);
    fireEvent.change(pickerSearch, { target: { value: "Every" } });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Everything" })).toBeInTheDocument());
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Everything" }), { clientX: 80, clientY: 80 });
    expect(actionBar).toBeInTheDocument();
    fireEvent.keyDown(pickerSearch, { key: "Escape" });

    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    const retryDeleteButton = await screen.findByRole("button", { name: "Delete Text" });

    onTextSelectionDelete.mockRejectedValueOnce({ kind: "stale_selection" });
    fireEvent.click(retryDeleteButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("The note changed");
    expect(screen.getByRole("button", { name: "Delete Text" })).toBeInTheDocument();
    onTextSelectionDelete.mockResolvedValueOnce(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Delete Text" }));
    expect(onTextSelectionDelete).toHaveBeenCalledWith(expect.objectContaining({
      type: "text_selection",
      sourceSlug: "test-block",
      selectedText: "beta",
      sourceBodyHash: "body-hash-1",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete Text" })).not.toBeInTheDocument());
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
    row.remove();
    selection?.removeAllRanges();
  });

  it("marks duplicate rendered markdown blocks with source offsets for deterministic anchoring", () => {
    const body = "Repeat\n\nRepeat";
    const { container } = render(
      <Detail
        block={block({
          body,
          body_hash: "body-hash-1",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const paragraphs = container.querySelectorAll("p");
    const secondParagraph = paragraphs[1]!;
    const textNode = secondParagraph.firstChild!;
    expect(secondParagraph).toHaveAttribute("data-mine-md-start", "8");
    expect(secondParagraph).toHaveAttribute("data-mine-md-end", "14");

    expect(textNode.textContent).toBe("Repeat");
  });

  it("decodes local wikilink image paths for original media and preview lookup", () => {
    const b = block({
      body: "![[Title (image 1).jpg]]",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "test-block.jpg",
        width: 1200,
        height: 628,
        tiles: [
          {
            source_path: "Title (image 1).jpg",
            preview_path: "Title (image 1)-preview.jpg",
            width: 1200,
            height: 628,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const imageSrcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(imageSrcs).toContain("asset://localhost//tmp/test-vault/Title (image 1).jpg");
    expect(imageSrcs).toContain("asset://localhost//tmp/thumbs/Title (image 1)-preview.jpg");

    const dragSurface = container.querySelector<HTMLElement>(
      "[data-detail-inline-media-drag='true']",
    );
    expect(dragSurface).not.toBeNull();
    expect(dragSurface).toHaveClass("not-prose", "[&_img]:m-0", "[&_video]:m-0");
    expect(dragSurface).toHaveClass("select-none");
    expect(dragSurface).toHaveAttribute("draggable", "false");
    for (const img of Array.from(dragSurface!.querySelectorAll("img"))) {
      expect(img).toHaveClass("block", "max-w-full");
    }
    // mousedown is left alone so the click that follows can open the preview;
    // the drag sensor still needs an 8px move before it engages.
    expect(dragSurface!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    )).toBe(true);
    // Native HTML drag stays suppressed — dragging is dnd-kit's job.
    expect(dragSurface!.dispatchEvent(
      new Event("dragstart", { bubbles: true, cancelable: true }),
    )).toBe(false);
  });

  it("stacks media-only paragraphs with multiple embeds instead of laying them out inline", () => {
    const b = block({
      body: "![[One.jpg]] ![[Two.jpg]]",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const stack = container.querySelector<HTMLElement>("[data-article-media-stack]");
    expect(stack).not.toBeNull();
    expect(stack).toHaveClass("not-prose", "leading-none");
    const frames = Array.from(stack!.children).filter((child) => (
      child instanceof HTMLElement && child.hasAttribute("data-detail-media-action-frame")
    ));
    expect(frames).toHaveLength(2);
  });

  it("hands the viewer every image of the card, in reading order", async () => {
    // The arrow keys step within a card, so clicking the second image must
    // still carry the first — the viewer cannot ask for it later.
    const onOpenImagePreview = vi.fn();
    const b = block({ body: "![[One.jpg]]\n\n![[Two.jpg]]" });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        onOpenImagePreview={onOpenImagePreview}
      />,
    );

    const frames = container.querySelectorAll<HTMLElement>("[data-detail-media-action-frame]");
    fireEvent.click(frames[1]!);

    const request = onOpenImagePreview.mock.calls[0]?.[0];
    expect(request.mediaRef).toBe("Two.jpg");
    expect(request.siblings.map((item: { mediaRef: string }) => item.mediaRef)).toEqual([
      "One.jpg",
      "Two.jpg",
    ]);
  });

  it("uses resolved backend tile path for bare Obsidian attachment embeds", () => {
    const b = block({
      body: "![[01.jpg]]",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "test-block.jpg",
        width: 1200,
        height: 628,
        tiles: [
          {
            source_path: "Библиотека/images/images/01.jpg",
            preview_path: null,
            width: 1200,
            height: 628,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const imageSrcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(imageSrcs).toContain("asset://localhost//tmp/test-vault/Библиотека/images/images/01.jpg");
  });

  it("decodes local wikilink video paths before handing them to VideoFromBlob", () => {
    const b = block({
      card_kind: "article",
      block_type: "image",
      body: "![[Clip (video 1).mp4]]",
    });

    render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByTestId("video-from-blob")).toHaveAttribute(
      "data-src",
      "asset://localhost//tmp/test-vault/Clip (video 1).mp4",
    );
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-controls", "true");
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-autoplay", "true");
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-muted", "true");
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-loop", "true");
  });

  it("renders media detail from card_kind instead of legacy block_type", () => {
    const b = block({
      card_kind: "media",
      block_type: "article",
      title: "Photo",
      media_file: "photo.jpg",
      body: "This markdown body must not drive media rendering.",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    // The card draws its local preview first and swaps in the original when it
    // arrives, so both are present: the original is the one that matters.
    const sources = Array.from(container.querySelectorAll("img")).map((img) =>
      img.getAttribute("src"),
    );
    expect(sources).toContain("asset://localhost//tmp/test-vault/photo.jpg");
    expect(container.querySelector("[data-article-body]")).toBeNull();
  });

  it("renders metadata-only link without a faux media panel", () => {
    const b = block({
      card_kind: "link",
      block_type: "link",
      title: "AI 2027",
      url: "https://ai-2027.com/race",
      media_file: null,
      thumbnail: null,
      body: "",
      preview_manifest: JSON.stringify({
        kind: "text",
        primary_preview_path: null,
        width: null,
        height: null,
        tiles: [],
        overflow_count: 0,
      }),
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(container.querySelector(".aspect-video")).toBeNull();
    expect(screen.getAllByText("AI 2027").length).toBeGreaterThan(0);
    // The type taxonomy is gone (decision 044): no Type row in metadata.
    expect(screen.queryByText("Link")).toBeNull();
  });

  it("shows the standard overflow menu trigger on image media surfaces", async () => {
    const onRenameMediaAsset = vi.fn().mockResolvedValue(undefined);
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        onRenameMediaAsset={onRenameMediaAsset}
      />,
    );

    const menu = container.querySelector("[data-detail-media-action-menu]");
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass(
      "right-2",
      "top-2",
      "opacity-0",
      "group-hover/detail-media:opacity-100",
    );
    const expandButton = menu!.querySelector("[data-detail-media-expand-button]");
    expect(expandButton).toHaveAttribute("aria-label", "Expand image");
    const trigger = menu!.querySelector("[data-detail-media-more-button]");
    expect(trigger).toHaveAttribute("data-variant", "default");
    expect(trigger).toHaveAttribute("data-size", "icon");
    expect(trigger).toHaveClass("button-depth", "rounded-1", "bg-depth-fill");
    expect(trigger?.className).not.toMatch(/(^|\s)hover:/);

    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);

    const dropdownMenu = await screen.findByRole("menu");
    expect(within(dropdownMenu).getByText("Create Element")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Reveal in Finder")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Copy Path")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Copy Media")).toBeInTheDocument();
    const renameItem = within(dropdownMenu).getByText("Rename Media...");
    expect(renameItem).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Remove from Element")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Delete Media")).toBeInTheDocument();
    const menuItemFor = (label: string) => (
      within(dropdownMenu).getByText(label).closest("[role='menuitem']") as HTMLElement
    );
    expect(menuItemFor("Create Element").querySelector("[data-card-menu-icon-slot] svg")).toBeTruthy();
    // Remove from Element (Unlink) and Delete Media (Trash2) carry real icons.
    expect(menuItemFor("Remove from Element").querySelector("[data-card-menu-icon-slot] svg")).toBeTruthy();
    expect(menuItemFor("Delete Media").querySelector("[data-card-menu-icon-slot] svg")).toBeTruthy();
    for (const label of [
      "Reveal in Finder",
      "Copy Path",
      "Copy Media",
      "Rename Media...",
    ]) {
      const iconSlot = menuItemFor(label).querySelector("[data-card-menu-icon-slot]");
      expect(iconSlot).toBeTruthy();
      expect(iconSlot?.querySelector("svg")).toBeNull();
    }

    fireEvent.click(renameItem);
    const dialog = await screen.findByRole("dialog", { name: "Rename media" });
    const input = within(dialog).getByLabelText("Filename");
    expect(input).toHaveValue("photo");
    fireEvent.change(input, { target: { value: "photo-renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(onRenameMediaAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          media_ref: "photo.jpg",
          media_kind: "image",
          source_slug: "test-block",
          reference_kind: "frontmatter_file",
        }),
        "photo-renamed",
      );
    });
  });

  // Г1.4: Remove on the second of two titled images of one file names that
  // image by its `![`, not the first one.
  it("removes the clicked one of two images of the same file", async () => {
    const onRemoveMediaAssetFromCard = vi.fn().mockResolvedValue(undefined);
    const b = block({
      card_kind: "article",
      block_type: "article",
      title: "Article",
      url: null,
      media_file: null,
      body: "Intro\n\n![a](Media/p.jpg \"t1\")\n\n![b](Media/p.jpg \"t2\")",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
      />,
    );

    const triggers = container.querySelectorAll("[data-detail-media-more-button]");
    expect(triggers).toHaveLength(2);
    fireEvent.pointerDown(triggers[1]!, { button: 0, ctrlKey: false });
    fireEvent.click(triggers[1]!);
    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Remove from Element"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from Element" }));

    await waitFor(() => {
      expect(onRemoveMediaAssetFromCard).toHaveBeenCalledWith(
        expect.objectContaining({
          media_ref: "Media/p.jpg",
          reference_kind: "body_embed",
          occurrence_index: 1,
        }),
      );
    });
  });

  it("opens the preview on image click and on Expand, and opens the media menu on right click", async () => {
    const onOpenImagePreview = vi.fn();
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        onOpenImagePreview={onOpenImagePreview}
      />,
    );

    // The preview is drawn behind the original, so the original is the last img.
    const images = Array.from(container.querySelectorAll("img"));
    const image = images[images.length - 1];
    expect(image).toHaveAttribute("src", "asset://localhost//tmp/test-vault/photo.jpg");

    // A click that never moved is a click: the drag sensor needs 8px to engage.
    fireEvent.click(image!);
    expect(onOpenImagePreview).toHaveBeenCalledWith({
      src: "asset://localhost//tmp/test-vault/photo.jpg",
      mediaRef: "photo.jpg",
      siblings: [{ src: "asset://localhost//tmp/test-vault/photo.jpg", mediaRef: "photo.jpg" }],
    });

    onOpenImagePreview.mockClear();
    const expandButton = container.querySelector("[data-detail-media-expand-button]");
    expect(expandButton).toHaveAttribute("aria-label", "Expand image");
    fireEvent.click(expandButton!);
    expect(onOpenImagePreview).toHaveBeenCalledWith({
      src: "asset://localhost//tmp/test-vault/photo.jpg",
      mediaRef: "photo.jpg",
      siblings: [{ src: "asset://localhost//tmp/test-vault/photo.jpg", mediaRef: "photo.jpg" }],
    });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();

    fireEvent.contextMenu(image!, { clientX: 140, clientY: 90 });
    const contextMenu = await screen.findByRole("menu");
    // A right click opens a context menu at the pointer, not the ellipsis menu.
    expect(contextMenu).toHaveAttribute("data-slot", "context-menu-content");
    expect(container.querySelector("[data-detail-media-more-button]")).toHaveAttribute("aria-expanded", "false");
    expect(within(contextMenu).getByText("Create Element")).toBeInTheDocument();
    expect(within(contextMenu).getByText("Rename Media...")).toBeInTheDocument();
    expect(within(contextMenu).getByText("Delete Media")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
  });

  it("opens the same menu items from the ellipsis and from a right click", async () => {
    const b = block({ card_kind: "media", block_type: "image", title: "Photo", url: null, media_file: "photo.jpg" });
    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        tags={[]}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-detail-media-action-frame]")!;
    fireEvent.contextMenu(frame, { clientX: 60, clientY: 40 });
    const fromRightClick = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Media actions" }), { button: 0, pointerType: "mouse" });
    const fromEllipsis = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
    expect(fromRightClick).toEqual(fromEllipsis);
    expect(fromRightClick).toEqual(["Create Element", "Reveal in Finder", "Copy Path", "Copy Media", "Rename Media...", "Remove from Element", "Delete Media"]);
  });

  it("uses the shared quantized list height for Create Element from image", () => {
    const asset: MediaAssetRef = {
      media_ref: "photo.jpg",
      media_kind: "image",
      source_slug: "test-block",
      reference_kind: "frontmatter_file",
    };
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent className={COLLECTION_PICKER_CONTENT_CLASS}>
          <MediaAssetCollectionPicker
            asset={asset}
            tags={Array.from({ length: 12 }, (_, index) => ({
              tag: `channel-${index}`,
              count: index,
            }))}
            onConnect={vi.fn()}
            onCreateAndConnect={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const scrollArea = document.querySelector("[data-quantized-menu-scroll-area]") as HTMLElement;
    const rows = Array.from(document.querySelectorAll("[data-slot='dropdown-menu-item']"));

    expect(scrollArea).toBeTruthy();
    expect(scrollArea).toHaveAttribute("data-menu-row-size", "default");
    expect(scrollArea).toHaveStyle({ maxHeight: "260px" });
    expect(scrollArea.style.getPropertyValue("--menu-row-height")).toBe("32px");
    expect(rows).toHaveLength(13);
    for (const row of rows) {
      expect(row).toHaveClass("h-[var(--menu-row-height)]", "py-0");
    }
  });

  it("shows delete media preview, affected cards, and deletes the media asset", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "Photo Card") {
        return block({
          id: 2,
          slug: "Photo Card",
          fallback_label: "Photo Card",
          display_title: "Photo Card",
          card_kind: "media",
          block_type: "image",
          media_file: "photo.jpg",
          thumb_format: "png",
          thumb_mtime: 111,
        });
      }
      if (slug === "Source Article") {
        return block({
          id: 3,
          slug: "Source Article",
          fallback_label: "Source Article",
          display_title: "Source Article",
          card_kind: "article",
          block_type: "article",
          body: "Article body",
          thumb_format: "jpeg",
          thumb_mtime: 222,
        });
      }
      return null;
    });
    prepareDeleteMediaAssetMock.mockResolvedValueOnce({
      media_ref: "photo.jpg",
      media_kind: "image",
      canvases: [],
      referenced_by: [
        {
          slug: "Photo Card",
          title: "Photo Card",
          display_title: "Photo Card",
          fallback_label: "Photo Card",
          card_kind: "media",
          reference_kinds: ["frontmatter_file"],
        },
        {
          slug: "Source Article",
          title: "Source Article",
          display_title: "Source Article",
          fallback_label: "Source Article",
          card_kind: "article",
          reference_kinds: ["body_embed"],
        },
      ],
    });
    const onDeleteMediaAsset = vi.fn().mockResolvedValue(undefined);
    const onOpenRelatedNote = vi.fn();
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onDeleteMediaAsset={onDeleteMediaAsset}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    const trigger = container.querySelector("[data-detail-media-more-button]");
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);

    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Delete Media"));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete media file?" });
    const photoRow = await within(dialog).findByRole("button", { name: "Photo Card" });
    const sourceRow = within(dialog).getByRole("button", { name: "Source Article" });
    // Photo Card shows the file as its main media: it will show nothing.
    expect(dialog).toHaveAccessibleDescription(
      "The file goes to the Trash. Its references are removed from the elements below and do not come back if you restore the file. Elements that show it as their main media will show nothing in its place.",
    );
    expect(within(dialog).getByText("Connected elements")).toBeInTheDocument();
    const connectedCardsScroll = dialog.querySelector("[data-delete-media-connected-cards-scroll]");
    expect(connectedCardsScroll).toHaveAttribute("data-visible-card-count", "5");
    expect(connectedCardsScroll).toHaveStyle({ maxHeight: "216px" });
    expect(within(dialog).queryByText("Primary media")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Inline media")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("2 cards reference this file.")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("photo.jpg")).not.toBeInTheDocument();
    expect(photoRow).toHaveAttribute("data-card-reference-item", "button");
    expect(photoRow).toHaveClass("bg-component-fill");
    expect(sourceRow).toHaveAttribute("data-card-reference-item", "button");
    expect(dialog.querySelector("img")).toHaveAttribute(
      "src",
      "asset://localhost//tmp/test-vault/photo.jpg",
    );

    vi.useFakeTimers();
    fireEvent.mouseEnter(photoRow);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    const hoverPreview = document.querySelector("[data-related-note-hover-preview]");
    expect(hoverPreview).not.toBeNull();
    expect(hoverPreview?.parentElement).toBe(document.body);
    expect(dialog.contains(hoverPreview)).toBe(false);
    // Read long past the warm window, it still hands over to the next row at
    // once: the window runs from when the preview left the screen.
    act(() => {
      vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS * 3);
    });
    fireEvent.mouseLeave(photoRow);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    fireEvent.mouseEnter(sourceRow);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).not.toBeNull();
    fireEvent.mouseLeave(sourceRow);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    vi.useRealTimers();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete media" }));

    await waitFor(() => {
      expect(onDeleteMediaAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          media_ref: "photo.jpg",
          media_kind: "image",
          source_slug: "test-block",
          reference_kind: "frontmatter_file",
        }),
      );
    });
  });

  it("keeps long connected card titles inside the delete media confirmation width", async () => {
    const longTitle =
      "A very long connected card title that should be truncated inside the media delete confirmation instead of widening the dialog";
    getBlockMock.mockResolvedValueOnce(block({
      id: 4,
      slug: "Long Source Article",
      fallback_label: longTitle,
      display_title: longTitle,
      title: longTitle,
      card_kind: "article",
      block_type: "article",
      body: "Article body",
    }));
    prepareDeleteMediaAssetMock.mockResolvedValueOnce({
      media_ref: "photo.jpg",
      media_kind: "image",
      canvases: [],
      referenced_by: [
        {
          slug: "Long Source Article",
          title: longTitle,
          display_title: longTitle,
          fallback_label: longTitle,
          card_kind: "article",
          reference_kinds: ["body_embed"],
        },
      ],
    });
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const trigger = container.querySelector("[data-detail-media-more-button]");
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);
    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Delete Media"));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete media file?" });
    const row = await within(dialog).findByRole("button", { name: longTitle });
    // Only embedded in a body: no element loses its main media.
    expect(dialog).toHaveAccessibleDescription(
      "The file goes to the Trash. Its references are removed from the elements below and do not come back if you restore the file.",
    );
    const scrollArea = dialog.querySelector("[data-delete-media-connected-cards-scroll]");
    const list = row.closest("[data-card-reference-list]");
    // The row also holds the thumbnail wrapper span, so match the label class
    // rather than the first span in document order.
    const label = row.querySelector("span.flex-1");

    expect(dialog).toHaveClass("min-w-0", "overflow-hidden");
    expect(scrollArea).toHaveClass("min-w-0", "overflow-y-auto");
    expect(list).toHaveClass("w-full", "min-w-0");
    expect(row).toHaveClass("w-full", "min-w-0", "overflow-hidden");
    expect(label).toHaveClass("min-w-0", "flex-1", "truncate");
  });

  it("opens referenced cards from the delete media confirmation", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "Source Article") {
        return block({
          id: 3,
          slug: "Source Article",
          fallback_label: "Source Article",
          display_title: "Source Article",
          card_kind: "article",
          block_type: "article",
          body: "Article body",
        });
      }
      return null;
    });
    prepareDeleteMediaAssetMock.mockResolvedValueOnce({
      media_ref: "photo.jpg",
      media_kind: "image",
      canvases: [],
      referenced_by: [
        {
          slug: "Source Article",
          title: "Source Article",
          display_title: "Source Article",
          fallback_label: "Source Article",
          card_kind: "article",
          reference_kinds: ["body_embed"],
        },
      ],
    });
    const onOpenRelatedNote = vi.fn();
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    const trigger = container.querySelector("[data-detail-media-more-button]");
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);
    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Delete Media"));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete media file?" });
    const sourceRow = await within(dialog).findByRole("button", { name: "Source Article" });
    fireEvent.click(sourceRow);

    expect(onOpenRelatedNote).toHaveBeenCalledWith("Source Article");
    expect(screen.queryByRole("alertdialog", { name: "Delete media file?" })).not.toBeInTheDocument();
  });

  describe("media card whose video is a body embed", () => {
    const manifest = (sources: string[]) => JSON.stringify({
      kind: "video_poster",
      primary_preview_path: "Cards/Post.jpg",
      width: 540, height: 290,
      tiles: sources.map((source) => ({ source_path: source, preview_path: "Cards/Post.preview-1.jpg", width: 540, height: 290, is_video: true, is_video_poster: true })),
      overflow_count: 0,
    });
    function renderPost(body: string, sources: string[]) {
      return render(
        <Detail
          block={block({ slug: "Cards/Post", card_kind: "media", block_type: "video", url: "https://x.com/a/status/1", media_file: null, body, preview_manifest: manifest(sources) })}
          vaultPath="/tmp/test-vault" thumbsRootPath="/tmp/thumbs" tags={[]}
          onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
          onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        />,
      );
    }

    it("shows the video once, playing on its own", () => {
      renderPost("![[Post (video 1).mp4]]", ["Media/Post (video 1).mp4"]);
      const videos = screen.getAllByTestId("video-from-blob");
      expect(videos).toHaveLength(1);
      expect(videos[0]).toHaveAttribute("data-autoplay", "true");
      expect(videos[0]).toHaveAttribute("data-muted", "true");
    });

    // Д1.1: an image before the lead video in the body. Remove on the player
    // names the video's own `![`, which the core removes only while it still
    // shows that video.
    it("removes the lead video when an image precedes it in the body", async () => {
      const body = "![[a.jpg]]\n\n![[clip.mp4]]";
      const failures: unknown[] = [];
      // The core: the reference starting at that `![` goes, and only when it
      // shows the media named.
      const onRemoveMediaAssetFromCard = vi.fn(async (asset: MediaAssetRef) => {
        const openers = [...body.matchAll(/!\[/g)].map((match) => match.index);
        const start = asset.occurrence_index == null ? undefined : openers[asset.occurrence_index];
        const fileName = asset.media_ref.split("/").pop() ?? asset.media_ref;
        if (start === undefined || !body.startsWith(`![[${fileName}]]`, start)) {
          const error = { kind: "invalid_media_ref", reason: "the image at that opener shows other media" };
          failures.push(error);
          throw error;
        }
      });
      const { container } = render(
        <Detail
          block={block({
            slug: "Cards/Post", card_kind: "media", block_type: "video", url: "https://x.com/a/status/1",
            media_file: null, body,
            preview_manifest: JSON.stringify({
              kind: "video_poster",
              primary_preview_path: "Cards/Post.jpg",
              width: 540, height: 290,
              tiles: [
                { source_path: "Media/a.jpg", preview_path: "Cards/Post.preview-1.jpg", width: 800, height: 600, is_video: false, is_video_poster: false },
                { source_path: "Media/clip.mp4", preview_path: "Cards/Post.preview-2.jpg", width: 540, height: 290, is_video: true, is_video_poster: true },
              ],
              overflow_count: 0,
            }),
          })}
          vaultPath="/tmp/test-vault" thumbsRootPath="/tmp/thumbs" tags={[]}
          onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
          onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
          onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
        />,
      );

      // The player leads; the body under it keeps the image, not the video again.
      const videos = screen.getAllByTestId("video-from-blob");
      expect(videos).toHaveLength(1);
      expect(videos[0]!.getAttribute("data-src")).toContain("clip.mp4");

      fireEvent.contextMenu(container.querySelector("video")!, { clientX: 120, clientY: 80 });
      const menu = await screen.findByRole("menu");
      fireEvent.click(within(menu).getByText("Remove from Element"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove from Element" }));

      await waitFor(() => expect(onRemoveMediaAssetFromCard).toHaveBeenCalledTimes(1));
      expect(onRemoveMediaAssetFromCard).toHaveBeenCalledWith(expect.objectContaining({
        media_ref: "Media/clip.mp4",
        reference_kind: "body_embed",
        occurrence_index: 1,
      }));
      await expect(onRemoveMediaAssetFromCard.mock.results[0]!.value).resolves.toBeUndefined();
      expect(failures).toEqual([]);
    });

    it("still shows the rest of the body under the lead video", () => {
      renderPost("![[Post (video 1).mp4]]\n\n![[Post (video 2).mp4]]", ["Media/Post (video 1).mp4", "Media/Post (video 2).mp4"]);
      const sources = screen.getAllByTestId("video-from-blob").map((video) => video.getAttribute("data-src"));
      expect(sources).toHaveLength(2);
      expect(sources[0]).toContain("video 1");
      expect(sources[1]).toContain("video 2");
    });
  });

  it("keeps the ellipsis off a video and opens its menu only on right click", async () => {
    const b = block({
      card_kind: "media",
      block_type: "video",
      title: "Clip",
      url: null,
      media_file: "clip.mp4",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    // The ellipsis covered the video's own controls.
    expect(container.querySelector("[data-detail-media-action-menu]")).toBeNull();
    fireEvent.contextMenu(video!, { clientX: 120, clientY: 80 });
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-slot", "context-menu-content");
    expect(within(menu).getByText("Delete Media")).toBeInTheDocument();
  });

  it("renders non-image media files as a file shell even with article legacy type", () => {
    const b = block({
      card_kind: "media",
      block_type: "article",
      title: "Report",
      url: null,
      media_file: "report.pdf",
      body: "# Report body",
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("[data-article-body]")).toBeNull();
  });

  it("renders article headings with design-system typography instead of prose defaults", () => {
    render(
      <Detail
        block={block({
          body: "# Heading\n\n## Section",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toHaveClass(
      "text-lg",
      "leading-6",
      "font-semibold",
    );
    expect(screen.getByRole("heading", { level: 2, name: "Section" })).toHaveClass(
      "text-base",
      "leading-5",
      "font-semibold",
    );
  });

  it("renders related notes as search rows: thumbnail, file name, dimmed text, no fill", async () => {
    vi.useFakeTimers();
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "First line from note body",
          display_title: "First line from note body",
          fallback_label: "Related Note",
          title: null,
          preview_text: "Notes on related things",
          thumb_format: "png",
          thumb_mtime: 123,
        });
      }
      if (slug === "second-note") {
        return block({
          id: 3,
          slug: "second-note",
          content_heading: "Second note body",
          display_title: "Second note body",
          fallback_label: "Second Note",
          title: null,
          preview_text: "Second note, continued here",
          thumb_format: "jpeg",
          thumb_mtime: 456,
        });
      }
      return null;
    });

    const onOpenRelatedNote = vi.fn();
    render(
      <Detail
        block={block({
          related_notes: ["related-note", "second-note"],
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The search's row (SPEC_SEARCH_OVERLAY.md): the file name, not the
    // visible title, then the note's text that does not repeat it.
    expect(screen.queryByText("First line from note body")).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /^related-note/ });
    const wrapper = row.closest("[data-card-row]") as HTMLElement;
    expect(wrapper).toHaveAttribute("data-related-note-item", "button");
    expect(row.querySelector("[data-card-row-name]")).toHaveTextContent(/^related-note$/);
    expect(row.querySelector("[data-card-row-name]")).toHaveClass("text-foreground");
    expect(row.querySelector("[data-card-row-text]")).toHaveTextContent(/^Notes on related things$/);
    expect(row.querySelector("[data-card-row-text]")).toHaveClass("text-muted-foreground");
    const secondRow = screen.getByRole("button", { name: /^second-note/ });
    expect(secondRow.querySelector("[data-card-row-text]")).toHaveTextContent(/^continued here$/);
    // No fill, no border: a row lights up only under the pointer.
    expect(wrapper).toHaveClass("relative", "rounded-1");
    expect(wrapper).not.toHaveClass("state-active");
    expect(wrapper.className).not.toMatch(/(?:^|\s)(?:bg-|border(?:\s|-|$))/);
    expect(row).toHaveClass("flex", "h-card-row", "items-center", "gap-2", "pl-card-thumb-inset", "pr-plate");
    expect(row.querySelector("[data-card-row-line]")).toHaveClass("font-sans", "text-base");

    const img = row.querySelector("img");
    // A row is 32 pixels like the sidebar strip, so it reads the micro level
    // rather than the 640px thumbnail behind it.
    expect(img).toHaveAttribute(
      "src",
      "asset://localhost//tmp/thumbs/related-note.micro.jpg?m=123",
    );
    expect(img).toHaveClass("dark:invert");

    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    const relatedPreview = document.querySelector("[data-related-note-hover-preview]");
    expect(relatedPreview).not.toBeNull();
    expect(relatedPreview).toHaveClass("pointer-events-none");
    expect(relatedPreview?.querySelector("button")).toBeNull();
    // The feed's own card unfolded, no lift (SPEC_CARD_STATES.md, С10).
    expect(relatedPreview?.querySelector("[data-card-preview]")).toHaveAttribute("data-card-preview-unfolded");
    expect(relatedPreview?.querySelector("[data-card-preview]")).not.toHaveAttribute("data-card-lift-pinned");
    expect(relatedPreview?.querySelector("[data-card-preview-collections]")).not.toBeNull();
    expect(relatedPreview).not.toHaveTextContent("Connect");
    expect(document.querySelector("[data-related-note-hover-bridge]")).not.toBeInTheDocument();

    fireEvent.mouseLeave(row);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    fireEvent.mouseEnter(secondRow);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const warmPreview = document.querySelector("[data-related-note-hover-preview]");
    expect(warmPreview).not.toBeNull();
    expect(warmPreview).toHaveTextContent("Second note body");
    expect(warmPreview?.querySelector("button")).toBeNull();

    fireEvent.mouseLeave(secondRow);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS + 1);
      await Promise.resolve();
    });

    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).not.toBeNull();

    fireEvent.click(row);
    expect(onOpenRelatedNote).toHaveBeenCalledWith("related-note");
  });

  it("does not open related note preview on focus", async () => {
    vi.useFakeTimers();
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          fallback_label: "Related Note",
          title: null,
        });
      }
      return null;
    });

    render(
      <Detail
        block={block({
          related_notes: ["related-note"],
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "related-note" });
    fireEvent.focus(row);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
  });

  it("refreshes related notes in-place after a vault snapshot refresh", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "test-block") {
        return block({
          related_notes: ["related-note"],
        });
      }
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "First line from note body",
          display_title: "First line from note body",
          fallback_label: "Related Note",
          title: null,
        });
      }
      return null;
    });

    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.queryByText("Related notes")).not.toBeInTheDocument();
    // No related notes, no empty card.
    expect(document.querySelectorAll("[data-detail-panel-card]")).toHaveLength(1);

    window.dispatchEvent(new Event("vault-refreshed"));

    await waitFor(() => {
      expect(screen.getByText("Related notes")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "related-note" })).toBeInTheDocument();
    });
    expect(screen.queryByText("First line from note body")).not.toBeInTheDocument();
  });

  it("gives a related note the card's commands under the pointer, as a search result row", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          title: null,
          preview_text: "Notes on related things",
        });
      }
      if (slug === "plain-note") {
        return block({ id: 3, slug: "plain-note", title: null, url: null });
      }
      return null;
    });
    const onOpenRelatedNote = vi.fn();
    const onRequestRename = vi.fn();
    const onRequestDelete = vi.fn();
    const { container } = render(
      <Detail
        block={block({ related_notes: ["related-note", "plain-note", "gone-note"] })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('[data-related-note-item="button"]')).toHaveLength(2);
    });
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-related-note-item="button"]'),
    );
    const commands = (row: HTMLElement) =>
      within(row).queryAllByRole("button").map((button) => button.getAttribute("aria-label")).filter(Boolean);

    // A link to a note that is gone: the name alone, dimmed, nothing to press.
    const gone = container.querySelector('[data-related-note-item="placeholder"]') as HTMLElement;
    expect(gone.querySelector("[data-card-row-name]")).toHaveTextContent(/^gone-note$/);
    expect(gone.querySelector("[data-card-row-name]")).toHaveClass("text-muted-foreground");
    expect(within(gone).queryByRole("button")).toBeNull();

    // At rest, no commands and no light.
    expect(first!.querySelector("[data-card-row-actions]")).toBeNull();
    fireEvent.pointerMove(first!);
    expect(first).toHaveClass("state-active");
    expect(commands(first!)).toEqual(["Card actions", "Source", "Connect"]);
    expect(first!.querySelector("[data-card-row-actions]")).toHaveAttribute("data-visible", "true");
    // The line stops short of three buttons: 3 × 24 + 2 × 4 + 8.
    expect((first!.querySelector("[data-card-row-line]") as HTMLElement).style.paddingRight).toBe("88px");

    // The pointer moves on: the commands go with it, Source only with a link.
    fireEvent.pointerLeave(first!);
    fireEvent.pointerMove(second!);
    expect(first!.querySelector("[data-card-row-actions]")).toBeNull();
    expect(first).not.toHaveClass("state-active");
    expect(commands(second!)).toEqual(["Card actions", "Connect"]);
    // A name alone stops short of two buttons: 2 × 24 + 4 + 8.
    expect((second!.querySelector("[data-card-row-line]") as HTMLElement).style.paddingRight).toBe("60px");

    // The menu holds its row; the pointer on its way out moves nothing.
    fireEvent.pointerLeave(second!);
    fireEvent.pointerMove(first!);
    fireEvent.pointerDown(within(first!).getByRole("button", { name: "Card actions" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    expect(onRequestRename).toHaveBeenCalledWith(expect.objectContaining({ slug: "related-note" }));
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
    });

    fireEvent.pointerMove(first!);
    fireEvent.pointerDown(within(first!).getByRole("button", { name: "Card actions" }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByRole("menuitem", { name: "Delete" });
    fireEvent.pointerLeave(first!);
    fireEvent.pointerMove(second!);
    expect(first!.querySelector("[data-card-row-actions]")).toHaveAttribute("data-visible", "true");
    expect(second!.querySelector("[data-card-row-actions]")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onRequestDelete).toHaveBeenCalledWith("related-note");

    // The commands never open the note; the rest of the row does.
    expect(onOpenRelatedNote).not.toHaveBeenCalled();
    fireEvent.click(within(first!).getByRole("button", { name: /^related-note/ }));
    expect(onOpenRelatedNote).toHaveBeenCalledWith("related-note");
  });

  // A file whose contents iCloud is holding is a state of the file, not a
  // broken card. See SPEC_CLOUD_STORAGE.md Х9, Х11.
  function cloudImageProps(contentInCloud: boolean) {
    return {
      // The feed's light card: only it knows where its media lives
      // (isContentInCloud in Detail.tsx, SPEC_CLOUD_STORAGE.md Х5).
      block: lightBlock({
        slug: "test-block",
        card_kind: "media",
        block_type: "image",
        title: "Photo",
        media_file: "photo.jpg",
        content_in_cloud: contentInCloud,
      }),
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
      onOpenRelatedNote: vi.fn(),
    };
  }

  it("keeps source geometry unchanged when a small preview is replaced by the original", () => {
    const props = cloudImageProps(false);
    props.block.width = 1600;
    props.block.height = 1200;
    const { container } = render(<Detail {...props} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    const preview = frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement;
    const original = frame.querySelector('img:not([data-detail-preview-backing])') as HTMLImageElement;
    const geometry = frame.getAttribute('style');
    expect(frame.style.aspectRatio).toBe('1600 / 1200');
    expect(preview).toHaveClass('absolute', 'size-full', 'object-contain');
    Object.defineProperties(preview, { naturalWidth: { value: 320 }, naturalHeight: { value: 240 } });
    fireEvent.load(preview);
    fireEvent.load(original);
    expect(frame.getAttribute('style')).toBe(geometry);
    expect(original).toHaveClass('absolute', 'size-full', 'object-contain');
    expect(frame.querySelector('[data-detail-preview-backing]')).toBeNull();
  });

  it("locks legacy preview geometry instead of growing when unknown-size original arrives", () => {
    const { container } = render(<Detail {...cloudImageProps(false)} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    const preview = frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement;
    const original = frame.querySelector('img:not([data-detail-preview-backing])') as HTMLImageElement;
    Object.defineProperties(preview, { naturalWidth: { value: 320 }, naturalHeight: { value: 240 } });
    fireEvent.load(preview);
    const geometry = frame.getAttribute('style');
    Object.defineProperties(original, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
    fireEvent.load(original);
    expect(frame.getAttribute('style')).toBe(geometry);
  });

  it("does not resize a displayed legacy image when metadata arrives later", () => {
    const props = cloudImageProps(false);
    const { container, rerender } = render(<Detail {...props} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    const preview = frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement;
    Object.defineProperties(preview, { naturalWidth: { value: 320 }, naturalHeight: { value: 240 } });
    fireEvent.load(preview);
    const geometry = frame.getAttribute('style');
    rerender(<Detail {...props} block={{ ...props.block, width: 1600, height: 1200 }} />);
    expect(frame.getAttribute('style')).toBe(geometry);
  });

  it("retains the preview and geometry when decoding fails", async () => {
    const props = cloudImageProps(false);
    props.block.width = 1600;
    props.block.height = 1200;
    const { container } = render(<Detail {...props} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    const geometry = frame.getAttribute('style');
    const original = frame.querySelector('img:not([data-detail-preview-backing])') as HTMLImageElement;
    Object.defineProperty(original, 'decode', { value: () => Promise.reject(new Error('decode')) });
    await act(async () => fireEvent.load(original));
    expect(frame.querySelector('[data-detail-preview-backing]')).not.toBeNull();
    expect(frame.getAttribute('style')).toBe(geometry);
  });

  it("keeps the preview until the original is decoded", async () => {
    const { container } = render(<Detail {...cloudImageProps(false)} />);
    const original = container.querySelector('[data-detail-image] img:not([data-detail-preview-backing])') as HTMLImageElement;
    let finishDecode!: () => void;
    Object.defineProperty(original, 'decode', { value: () => new Promise<void>(resolve => { finishDecode = resolve; }) });
    fireEvent.load(original);
    expect(container.querySelector('[data-detail-preview-backing]')).not.toBeNull();
    await act(async () => finishDecode());
    expect(container.querySelector('[data-detail-preview-backing]')).toBeNull();
  });

  it("resets the image frame when navigating to a different source", () => {
    const props = cloudImageProps(false);
    props.block.width = 1600;
    props.block.height = 1200;
    const { container, rerender } = render(<Detail {...props} />);
    rerender(<Detail {...props} block={{ ...props.block, media_file: 'portrait.jpg', width: 1200, height: 1600 }} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    expect(frame.style.aspectRatio).toBe('1200 / 1600');
    expect(frame.querySelector('[data-detail-preview-backing]')).not.toBeNull();
  });

  // A preview file that is not there yet is not a broken picture
  // (SPEC_THUMBNAILS.md, «Нет файла миниатюры»).
  function announceThumbUpdated(slug: string) {
    act(() => {
      window.dispatchEvent(new CustomEvent("thumb:updated", {
        detail: { event: "thumb:updated", payload: { path: "/tmp/test-vault", slug } },
      }));
    });
  }

  it("keeps the loading look instead of a broken image when the preview file is missing", () => {
    const props = cloudImageProps(false);
    props.block.width = 1600;
    props.block.height = 1200;
    const { container } = render(<Detail {...props} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    const geometry = frame.getAttribute('style');
    const original = frame.querySelector('img:not([data-detail-preview-backing])') as HTMLImageElement;

    fireEvent.error(frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement);

    // No backing element is left to draw the icon; the original keeps loading
    // unseen and the frame keeps its box, exactly as while loading.
    expect(frame.querySelector('[data-detail-preview-backing]')).toBeNull();
    expect(original).toHaveStyle({ opacity: '0' });
    expect(frame.getAttribute('style')).toBe(geometry);
  });

  it("loads the backing again when this card's preview is ready, and not for another card", async () => {
    const props = cloudImageProps(false);
    const { container } = render(<Detail {...props} />);
    const frame = container.querySelector('[data-detail-image]') as HTMLElement;
    const backingSrc = (frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement).getAttribute('src');
    fireEvent.error(frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement);
    await act(async () => {});

    announceThumbUpdated('another-card');
    expect(frame.querySelector('[data-detail-preview-backing]')).toBeNull();

    announceThumbUpdated(props.block.slug);
    const backing = frame.querySelector('[data-detail-preview-backing]') as HTMLImageElement;
    expect(backing).not.toBeNull();
    // A new address: the browser asks the file again rather than repeating
    // the failure from its memory cache.
    expect(backing.getAttribute('src')).toBe(`${backingSrc}${backingSrc?.includes('?') ? '&' : '?'}retry=1`);
  });

  it("names the file's state when its contents cannot be fetched from iCloud", () => {
    const { container } = render(<Detail {...cloudImageProps(true)} />);

    const original = container.querySelector(
      '[data-detail-image] img:not([data-detail-preview-backing])',
    ) as HTMLImageElement;
    expect(container.querySelector('[data-detail-cloud-state="offline"]')).toBeNull();

    fireEvent.error(original);

    const offline = container.querySelector('[data-detail-cloud-state="offline"]');
    expect(offline).not.toBeNull();
    expect(offline).toHaveTextContent("Original is in iCloud, not available offline");
    // The image is not hidden: whatever is already showing keeps showing.
    expect(original.style.display).not.toBe("none");
  });

  it("re-requests the original when the reader tries again", () => {
    const { container } = render(<Detail {...cloudImageProps(true)} />);

    const imageSelector = '[data-detail-image] img:not([data-detail-preview-backing])';
    const before = (container.querySelector(imageSelector) as HTMLImageElement).getAttribute("src");
    fireEvent.error(container.querySelector(imageSelector) as HTMLImageElement);

    fireEvent.click(screen.getByText("Try again"));

    const after = (container.querySelector(imageSelector) as HTMLImageElement).getAttribute("src");
    // A retry that reuses the cached failure is not a retry.
    expect(after).not.toBe(before);
    expect(after).toContain("retry=1");
    expect(container.querySelector('[data-detail-cloud-state="offline"]')).toBeNull();
  });

  it("keeps a local file's failure silent about the cloud", () => {
    const { container } = render(<Detail {...cloudImageProps(false)} />);

    fireEvent.error(
      container.querySelector(
        '[data-detail-image] img:not([data-detail-preview-backing])',
      ) as HTMLImageElement,
    );

    expect(container.querySelector("[data-detail-cloud-state]")).toBeNull();
  });

  it("waits before saying anything about a download in progress", () => {
    vi.useFakeTimers();
    const { container } = render(<Detail {...cloudImageProps(true)} />);

    // Nothing yet: a file that arrives quickly must not flash a notice.
    expect(container.querySelector('[data-detail-cloud-state="downloading"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const downloading = container.querySelector('[data-detail-cloud-state="downloading"]');
    expect(downloading).not.toBeNull();
    expect(downloading).toHaveTextContent("Downloading from iCloud");
  });

  it("shows the system's percent when macOS publishes one, and never invents it", async () => {
    vi.useFakeTimers();
    const progressMock = vi.mocked(icloudDownloadProgress);
    progressMock.mockResolvedValue({ status: "downloading", percent: 41.7 });

    const { container } = render(<Detail {...cloudImageProps(true)} />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(progressMock).toHaveBeenCalledWith("photo.jpg");
    const downloading = container.querySelector('[data-detail-cloud-state="downloading"]');
    expect(downloading).toHaveTextContent("Downloading from iCloud · 42%");
  });

  it("keeps the numberless indicator when the system publishes no percent", async () => {
    vi.useFakeTimers();
    const progressMock = vi.mocked(icloudDownloadProgress);
    progressMock.mockResolvedValue({ status: "not_downloaded", percent: null });

    const { container } = render(<Detail {...cloudImageProps(true)} />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const downloading = container.querySelector('[data-detail-cloud-state="downloading"]');
    expect(downloading).toHaveTextContent("Downloading from iCloud");
    expect(downloading!.textContent).not.toContain("%");
  });

  it("shows the copy-wait indicator only when a copy outlives the delay", async () => {
    vi.useFakeTimers();
    let settle: () => void = () => {};
    copyMediaAssetToClipboardMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    const { container } = render(<Detail {...cloudImageProps(true)} />);
    const trigger = container.querySelector("[data-detail-media-more-button]")!;
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    // findBy* waits on real time, which fake timers freeze; the menu mounts
    // within a tick, so advance the fake clock and query directly.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Copy Media"));

    // A fast copy never flashes anything.
    expect(container.querySelector("[data-detail-copy-waiting]")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector("[data-detail-copy-waiting]")).toHaveTextContent(
      "Downloading from iCloud",
    );

    await act(async () => {
      settle();
    });
    expect(container.querySelector("[data-detail-copy-waiting]")).toBeNull();
  });

  it("stops asking once the original arrived", async () => {
    vi.useFakeTimers();
    const progressMock = vi.mocked(icloudDownloadProgress);
    progressMock.mockResolvedValue({ status: "downloading", percent: 10 });

    const { container } = render(<Detail {...cloudImageProps(true)} />);
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    const callsWhileWaiting = progressMock.mock.calls.length;
    expect(callsWhileWaiting).toBeGreaterThan(0);

    const original = container.querySelector(
      '[data-detail-image] img:not([data-detail-preview-backing])',
    ) as HTMLImageElement;
    act(() => {
      fireEvent.load(original);
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(progressMock.mock.calls.length).toBe(callsWhileWaiting);
    expect(container.querySelector("[data-detail-cloud-state]")).toBeNull();
  });
});

// SPEC_CARD_ASSOCIATIONS.md, «Открытая карточка»: blocks of cards related to
// the open one by address, author or site, under Related notes, in both views.
describe("Detail association blocks", () => {
  const initialViewportWidth = window.innerWidth;
  const listCardAssociationsMock = vi.mocked(listCardAssociations);

  function light(slug: string): LightBlock {
    return {
      id: slug.length + 100,
      slug,
      block_type: "article",
      card_kind: "article",
      title: null,
      content_heading: null,
      display_title: null,
      fallback_label: slug,
      url: null,
      media_file: null,
      thumbnail: null,
      saved_at: "2026-01-01T00:00:00Z",
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

  function group(kind: CardAssociationKind, label: string, slugs: string[]): CardAssociationGroup {
    return { kind, label, blocks: slugs.map((slug) => light(slug)) };
  }

  function renderOpenCard(props: Partial<Parameters<typeof Detail>[0]> = {}) {
    return render(
      <Detail
        block={block({ slug: "open", author: "@kotecinho", related_notes: ["related"] })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
        {...props}
      />,
    );
  }

  beforeEach(() => {
    getBlockMock.mockReset();
    getBlockMock.mockImplementation(async (slug: string) => (
      slug === "related" ? block({ id: 2, slug: "related", fallback_label: "related" }) : null
    ));
    listCardAssociationsMock.mockReset();
    listCardAssociationsMock.mockResolvedValue({
      generation: 5,
      slug: "open",
      groups: [
        group("address", "https://x.com/kotecinho/status/1", ["piece"]),
        group("author", "@kotecinho", ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]),
      ],
    });
  });

  afterEach(() => {
    setViewportWidth(initialViewportWidth);
  });

  it.each([
    ["rail", 1400],
    ["stacked", 900],
  ])("stand under Related notes in the %s view, each in the panel's card", async (mode, width) => {
    setViewportWidth(width);
    const { container } = renderOpenCard();

    await waitFor(() => {
      expect(container.querySelectorAll("[data-card-association-block]")).toHaveLength(2);
    });
    expect(container.querySelector("[data-detail-layout-mode]")).toHaveAttribute("data-detail-layout-mode", mode);
    // Related notes are left out of the read: the panel shows them already.
    expect(listCardAssociationsMock).toHaveBeenCalledWith("open", ["related"]);

    const sections = container.querySelector("[data-metadata-sections]")!;
    const cards = [...sections.children];
    const related = container.querySelector("[data-related-notes-block]");
    const [address, author] = container.querySelectorAll("[data-card-association-block]");
    expect(cards.indexOf(related!)).toBe(1);
    expect(cards.indexOf(address!)).toBe(2);
    expect(cards.indexOf(author!)).toBe(3);
    // The same card as Related notes: one shell, the heading inside.
    expect(address).toHaveAttribute("data-detail-panel-card");
    expect(address?.className).toBe(related?.className);
    expect(address).toHaveAttribute("data-card-association-block", "address");
    const sameUrl = within(address as HTMLElement).getByText("Same URL");
    expect(sameUrl).toHaveClass("min-w-0", "truncate");
    expect(sameUrl.parentElement).toHaveClass("flex", "h-row", "items-center", "px-surface");
    expect(address?.querySelector("[data-card-association-list] [data-card-row] > button"))
      .toHaveClass("h-card-row", "pl-card-thumb-inset", "pr-plate");
  });

  it("names the author on a button that opens the author's feed and shows every row", async () => {
    const onOpenAuthorFeed = vi.fn();
    const { container } = renderOpenCard({ onOpenAuthorFeed });
    const heading = await screen.findByRole("button", { name: "@kotecinho" });
    expect(heading).toHaveAttribute("title", "All cards by @kotecinho");
    fireEvent.click(heading);
    expect(onOpenAuthorFeed).toHaveBeenCalledWith("@kotecinho");

    // Every row at once, nothing after the list.
    const author = container.querySelector('[data-card-association-block="author"]') as HTMLElement;
    expect(author.querySelectorAll('[data-card-association-item="button"]')).toHaveLength(9);
    expect(author.lastElementChild).toHaveAttribute("data-card-association-list");
    expect(within(author).queryByRole("button", { name: /^Show / })).toBeNull();
  });

  it("names a site by its host as text and shows every row", async () => {
    listCardAssociationsMock.mockResolvedValue({
      generation: 5,
      slug: "open",
      groups: [group("site", "niklasrosen.se", ["a", "b", "c", "d", "e", "f", "g"])],
    });
    const { container } = renderOpenCard({
      block: block({ slug: "open", url: "https://niklasrosen.se/x", related_notes: [] }),
    });
    const site = await waitFor(() => {
      const found = container.querySelector('[data-card-association-block="site"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(site).queryByRole("button", { name: "niklasrosen.se" })).toBeNull();
    expect(within(site).getByText("niklasrosen.se")).toBeInTheDocument();
    expect(site.querySelectorAll('[data-card-association-item="button"]')).toHaveLength(7);
    expect(site.lastElementChild).toHaveAttribute("data-card-association-list");
    expect(within(site).queryByRole("button", { name: /^Show / })).toBeNull();
  });

  it("opens a row's card and shows its commands under the pointer", async () => {
    const onOpenRelatedNote = vi.fn();
    const { container } = renderOpenCard({ onOpenRelatedNote });
    const address = await waitFor(() => {
      const found = container.querySelector('[data-card-association-block="address"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const row = address.querySelector('[data-card-association-item="button"]') as HTMLElement;
    fireEvent.pointerMove(row);
    expect(await within(address).findByRole("button", { name: "Connect" })).toBeInTheDocument();
    fireEvent.click(within(row).getByText("piece"));
    expect(onOpenRelatedNote).toHaveBeenCalledWith("piece");
  });

  it("times a row's preview by the shared card preview rule", async () => {
    setViewportWidth(1400);
    const written = (slug: string) => ({ ...light(slug), body: `Body of ${slug}` });
    listCardAssociationsMock.mockResolvedValue({
      generation: 5,
      slug: "open",
      groups: [{ kind: "author", label: "@kotecinho", blocks: ["one", "two"].map(written) }],
    });
    const { container } = renderOpenCard();
    const author = await waitFor(() => {
      const found = container.querySelector('[data-card-association-block="author"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const [one, two] = Array.from(
      author.querySelectorAll<HTMLElement>('[data-card-association-item="button"]'),
    );
    const preview = () => document.querySelector("[data-related-note-hover-preview]");
    const settle = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    vi.useFakeTimers(INTENT_TIMERS);
    try {
      // The panel feeds the pointer's speed: a pointer still moving along the
      // row past the delay opens nothing until it rests.
      fireEvent.mouseEnter(one!);
      for (let elapsed = 0; elapsed < HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 100; elapsed += 16) {
        await settle(16);
        fireEvent.pointerMove(one!, { clientX: 100 + elapsed, clientY: 10 });
      }
      expect(preview()).toBeNull();
      await settle(HOVER_INTENT.velocityWindowMs * 2);
      expect(preview()).toHaveTextContent("Body of one");

      // Read long past the warm window, it hands over to the next row at once.
      await settle(HOVER_PREVIEW_WARM_WINDOW_MS * 3);
      fireEvent.mouseLeave(one!);
      expect(preview()).toBeNull();
      fireEvent.mouseEnter(two!);
      await settle(0);
      expect(preview()).toHaveTextContent("Body of two");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads again on vault-refreshed and keeps a newer answer over an older one", async () => {
    setViewportWidth(1400);
    let refreshed = false;
    listCardAssociationsMock.mockImplementation(async () => (
      refreshed
        ? { generation: 3, slug: "open", groups: [group("address", "u", ["older"])] }
        : { generation: 9, slug: "open", groups: [group("address", "u", ["newer"])] }
    ));
    renderOpenCard();
    expect(await screen.findByText("newer")).toBeInTheDocument();
    const callsBefore = listCardAssociationsMock.mock.calls.length;
    refreshed = true;
    act(() => {
      window.dispatchEvent(new Event("vault-refreshed"));
    });
    await waitFor(() => expect(listCardAssociationsMock.mock.calls.length).toBeGreaterThan(callsBefore));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("newer")).toBeInTheDocument();
    expect(screen.queryByText("older")).toBeNull();
  });

  it("draws no block for a card without associations or when the read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    listCardAssociationsMock.mockRejectedValue(new Error("index busy"));
    const { container } = renderOpenCard();
    await waitFor(() => expect(listCardAssociationsMock).toHaveBeenCalled());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(container.querySelector("[data-card-association-block]")).toBeNull();
    expect(await screen.findByText("Related notes")).toBeInTheDocument();
    error.mockRestore();
  });
});

// SPEC_DEEP_AUDIT.md, Е6.8: the file `Delete media file?` names may be gone or
// in iCloud; its preview keeps the tile, never the broken-image icon.
describe("Delete media file? preview", () => {
  it("shows no broken-image icon for a file that will not load", () => {
    vi.mocked(prepareDeleteMediaAsset).mockReturnValue(new Promise(() => {}));
    const asset: MediaAssetRef = {
      media_ref: "Media/gone.jpg",
      media_kind: "image",
      source_slug: "note",
      reference_kind: "body_embed",
    };
    render(
      <DeleteMediaAssetDialog
        asset={asset}
        vaultPath="/vault"
        open
        onOpenChange={vi.fn()}
        onDelete={vi.fn(async () => {})}
        onOpenRelatedNote={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    fireEvent.error(dialog.querySelector("img") as HTMLImageElement);
    expect(dialog.querySelector("img")).toBeNull();
  });
});

// SPEC_DEEP_AUDIT.md, Е6.13: an open card of the feed carries only the start
// of its text. When the file cannot be read, the card says it shows only
// that start, in the tab's notice; before, the start stood as the whole text
// and the failure went to the console.
describe("an open card whose text could not be read", () => {
  it("says it shows only the beginning of the text", async () => {
    clearActionFailures();
    vi.mocked(getBlock).mockRejectedValue(new Error("The file is in iCloud and could not be read."));
    const light = lightBlock({
      slug: "test-block",
      title: "Test Block",
      url: "https://example.com/article",
      body: "A long beginning ".repeat(20),
    });
    render(
      <>
        <Detail
          block={light}
          vaultPath="/tmp/fixture" thumbsRootPath="/tmp/thumbs" tags={[]}
          onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
          onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        />
        <ActionFailureNoticeStack />
      </>,
    );

    expect(await screen.findByText("Could not read the element")).toBeInTheDocument();
    expect(screen.getByText("The open element shows only the beginning of its text.")).toBeInTheDocument();
    expect(screen.getByText("The file is in iCloud and could not be read.")).toBeInTheDocument();
    vi.mocked(getBlock).mockReset();
    clearActionFailures();
  });
});

// One media frame for pictures and videos and one height limit
// (SPEC_FRONTEND.md, «Раскладка открытой карточки», Р5 to Р7).
describe("an open card's media frame", () => {
  function renderCard(b: IndexedBlock) {
    return render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault" thumbsRootPath="/tmp/thumbs" tags={[]}
        onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );
  }

  const videoTile = (width: number, height: number) => JSON.stringify({
    kind: "image",
    primary_preview_path: "Cards/test-block.jpg",
    tiles: [{ source_path: "Media/clip.mp4", preview_path: "Cards/test-block.preview-1.jpg", width, height, is_video: true, is_video_poster: true }],
  });

  it("carries the one height limit from the root to every media frame", () => {
    const { container } = renderCard(block({ body: "![[clip.mp4]]\n\n![[photo.jpg]]" }));
    const root = container.querySelector<HTMLElement>("[data-detail-root]")!;
    expect(root.style.getPropertyValue("--detail-media-max-height")).toBe("85vh");
    const frames = container.querySelectorAll("[data-detail-media-action-frame]");
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame).toHaveClass("max-h-[var(--detail-media-max-height)]");
    }
    // No element keeps a limit of its own.
    expect(container.querySelectorAll('[class*="85vh"]')).toHaveLength(0);
  });

  it("takes the height limit of its own frame in the card's window (SPEC_CARD_PEEK.md, О8)", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    try {
      const { container } = render(
        <Detail
          block={block({ body: "![[photo.jpg]]" })}
          sizedBy="frame"
          vaultPath="/tmp/test-vault" thumbsRootPath="/tmp/thumbs" tags={[]}
          onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
          onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        />,
      );
      const root = container.querySelector<HTMLElement>("[data-detail-root]")!;
      // 85 % of the frame's 600 px, not of the app window's height.
      await waitFor(() => expect(root.style.getPropertyValue("--detail-media-max-height")).toBe("510px"));
    } finally {
      height.mockRestore();
    }
  });

  it("draws a body video in the frame of its recorded size, the video filling it", () => {
    const { container } = renderCard(block({ body: "Text before.\n\n![[clip.mp4]]", preview_manifest: videoTile(1080, 1920) }));
    const frame = container.querySelector<HTMLElement>("[data-article-media-stack] [data-detail-video]")!;
    expect(frame.style.aspectRatio).toBe("1080 / 1920");
    expect(frame.style.maxWidth).toBe("100%");
    expect(frame.querySelector("video")).toHaveClass("absolute", "inset-0", "size-full", "object-contain");
  });

  it("frames a body video without a recorded size by the size its metadata reports", () => {
    const { container } = renderCard(block({ body: "![[clip.mp4]]" }));
    const frame = container.querySelector<HTMLElement>("[data-detail-video]")!;
    const video = frame.querySelector("video")!;
    expect(frame.style.aspectRatio).toBe("");
    expect(video).toHaveClass("h-auto", "max-h-[var(--detail-media-max-height)]");
    Object.defineProperties(video, { videoWidth: { value: 720 }, videoHeight: { value: 1280 } });
    fireEvent.loadedMetadata(video);
    expect(frame.style.aspectRatio).toBe("720 / 1280");
    expect(video).toHaveClass("absolute", "inset-0", "size-full");
  });

  it("keeps the recorded frame while the video's proportion matches, and takes the video's when it is turned", () => {
    const clip = block({ card_kind: "media", block_type: "video", url: null, media_file: "Media/clip.mp4", width: 1920, height: 1080 });
    const { container } = renderCard(clip);
    const frame = container.querySelector<HTMLElement>("[data-detail-video]")!;
    const video = frame.querySelector("video")!;
    expect(frame.style.aspectRatio).toBe("1920 / 1080");
    Object.defineProperties(video, { videoWidth: { value: 960, configurable: true }, videoHeight: { value: 540, configurable: true } });
    fireEvent.loadedMetadata(video);
    expect(frame.style.aspectRatio).toBe("1920 / 1080");
    Object.defineProperties(video, { videoWidth: { value: 1080 }, videoHeight: { value: 1920 } });
    fireEvent.loadedMetadata(video);
    expect(frame.style.aspectRatio).toBe("1080 / 1920");
  });

  it("centres the article's lead video, its space under it outside the frame", () => {
    const { container } = renderCard(block({
      url: "https://www.youtube.com/watch?v=9KDDhAOyv9k",
      media_file: "Media/film.mp4",
      width: 1280,
      height: 720,
      body: "Transcript.",
    }));
    const lead = container.querySelector<HTMLElement>("[data-detail-lead-video]")!;
    expect(lead).toHaveClass("mb-6", "flex", "justify-center");
    const frame = lead.querySelector<HTMLElement>("[data-detail-video]")!;
    expect(frame.style.aspectRatio).toBe("1280 / 720");
    expect(frame.querySelector("video")).not.toHaveClass("mb-6");
  });
});

// A link's page picture in the one media frame, one path for the link card
// and a media card that shows a link (SPEC_FRONTEND.md, «Раскладка открытой
// карточки», Р9; user's decision of 16.10.2026). It is no media asset, so ⤢
// and a click are its only controls (SPEC_MEDIA_ASSET_ACTIONS.md,
// «Картинка страницы у ссылки»).
describe("an open link card's page picture", () => {
  const PREVIEW_SRC = "asset://localhost//tmp/thumbs/test-block.jpg";

  beforeEach(() => {
    getBlockMock.mockReset();
    getBlockMock.mockResolvedValue(null);
  });

  function pagePictureManifest(size: { width: number; height: number } | null) {
    return JSON.stringify({
      kind: "image",
      primary_preview_path: "test-block.jpg",
      width: size?.width ?? null,
      height: size?.height ?? null,
      tiles: [{ source_path: "Media/og.png", width: size?.width ?? null, height: size?.height ?? null, is_video: false, is_video_poster: false }],
      overflow_count: 0,
    });
  }

  function linkBlock(cardKind: "link" | "media", size: { width: number; height: number } | null) {
    return block({
      card_kind: cardKind,
      block_type: "link",
      title: "Page Title",
      description: "The page's description.",
      url: "https://example.com/page",
      media_file: null,
      thumbnail: "Media/og.png",
      body: "",
      preview_manifest: pagePictureManifest(size),
    });
  }

  function renderLink(b: IndexedBlock, onOpenImagePreview = vi.fn()) {
    return render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault" thumbsRootPath="/tmp/thumbs" tags={[]}
        onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
        onOpenImagePreview={onOpenImagePreview}
      />,
    );
  }

  it.each(["link", "media"] as const)("draws a 3:1 page picture in a frame of its own proportion, without the grey 16:9 box (%s card)", (cardKind) => {
    const { container } = renderLink(linkBlock(cardKind, { width: 1200, height: 400 }));
    const column = container.querySelector("[data-detail-article-column]")!;
    expect(column.querySelector(".aspect-video")).toBeNull();
    expect(column.querySelector(".bg-accent")).toBeNull();
    const picture = column.querySelector<HTMLElement>("[data-detail-link-picture]")!;
    expect(picture).toHaveClass("flex", "justify-center");
    const frame = picture.querySelector<HTMLElement>("[data-detail-image]")!;
    expect(frame.style.aspectRatio).toBe("1200 / 400");
    expect(frame.style.width).toBe("min(1200px, calc(var(--detail-media-max-height) * 1200 / 400))");
    expect(frame.style.maxWidth).toBe("100%");
    const image = frame.querySelector("img")!;
    expect(image).toHaveAttribute("src", PREVIEW_SRC);
    expect(image).toHaveClass("absolute", "inset-0", "size-full", "object-contain");
    // The title and the description stay under the picture.
    expect(within(column as HTMLElement).getByRole("heading", { name: "Page Title" })).toBeInTheDocument();
    expect(within(column as HTMLElement).getByText("The page's description.")).toBeInTheDocument();
    expect(picture.compareDocumentPosition(within(column as HTMLElement).getByRole("heading", { name: "Page Title" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A link holds the reading column (Р1).
    expect(container.querySelector("[data-detail-layout-mode]")).toHaveAttribute("data-detail-content-width", String(DETAIL_CONTENT_MAX_WIDTH_PX));
  });

  it("frames a page picture without a recorded size by the size it loads with", () => {
    const { container } = renderLink(linkBlock("link", null));
    const frame = container.querySelector<HTMLElement>("[data-detail-link-picture] [data-detail-image]")!;
    expect(frame.style.aspectRatio).toBe("");
    const image = frame.querySelector("img")!;
    Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 800 } });
    fireEvent.load(image);
    expect(frame.style.aspectRatio).toBe("600 / 800");
    expect(image).toHaveClass("absolute", "inset-0", "size-full");
  });

  it("gives the page picture ⤢ and a click into the viewer, without the media menu", async () => {
    const onOpenImagePreview = vi.fn();
    const { container } = renderLink(linkBlock("link", { width: 1200, height: 400 }), onOpenImagePreview);
    const picture = container.querySelector<HTMLElement>("[data-detail-link-picture]")!;
    const controls = picture.querySelector("[data-detail-media-action-menu]")!;
    expect(controls).toHaveClass("right-2", "top-2", "opacity-0", "group-hover/detail-media:opacity-100");
    expect(controls.parentElement).toHaveAttribute("data-detail-media-action-frame");
    expect(controls.parentElement).toHaveClass("group/detail-media", "inline-flex", "max-h-[var(--detail-media-max-height)]");
    expect(picture.querySelector("[data-detail-media-more-button]")).toBeNull();
    expect(picture.querySelector("[data-media-asset-ref]")).toBeNull();

    fireEvent.click(picture.querySelector("[data-detail-image] img")!);
    expect(onOpenImagePreview).toHaveBeenCalledTimes(1);
    expect(onOpenImagePreview).toHaveBeenLastCalledWith({ src: PREVIEW_SRC, mediaRef: null });

    const expand = controls.querySelector("[data-detail-media-expand-button]")!;
    expect(expand).toHaveAttribute("aria-label", "Expand image");
    fireEvent.click(expand);
    expect(onOpenImagePreview).toHaveBeenCalledTimes(2);
    expect(onOpenImagePreview).toHaveBeenLastCalledWith({ src: PREVIEW_SRC, mediaRef: null });

    fireEvent.contextMenu(picture.querySelector("[data-detail-image] img")!, { clientX: 120, clientY: 80 });
    await act(async () => {});
    expect(screen.queryByText("Rename Media...")).toBeNull();
    expect(screen.queryByText("Create Element")).toBeNull();
  });

  it("removes the page picture with its frame and controls when it will not load", () => {
    const { container } = renderLink(linkBlock("link", { width: 1200, height: 400 }));
    fireEvent.error(container.querySelector("[data-detail-link-picture] [data-detail-image] img")!);
    expect(container.querySelector("[data-detail-link-picture]")).toBeNull();
    expect(container.querySelector("[data-detail-media-expand-button]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Page Title" })).toBeInTheDocument();
  });
});

// A recorded size of another proportion than the picture's own is wrong: the
// frame takes the original's size once it loads, as a video's frame does
// (SPEC_FRONTEND.md, «Раскладка открытой карточки», Р6; user's decision of
// 16.10.2026).
describe("an open card's picture whose record has a wrong size", () => {
  beforeEach(() => {
    getBlockMock.mockReset();
    getBlockMock.mockResolvedValue(null);
  });

  function pictureBlock(width: number, height: number) {
    return block({ card_kind: "media", block_type: "image", url: null, media_file: "Media/wide.jpg", width, height });
  }

  function renderPicture(b: IndexedBlock) {
    const view = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault" thumbsRootPath="/tmp/thumbs" tags={[]}
        onClose={vi.fn()} onNavigate={vi.fn()} onToggleTag={vi.fn()} onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} onOpenRelatedNote={vi.fn()}
      />,
    );
    const frame = view.container.querySelector<HTMLElement>("[data-detail-image]")!;
    return {
      ...view,
      frame,
      preview: frame.querySelector<HTMLImageElement>("[data-detail-preview-backing]")!,
      original: frame.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])")!,
      contentWidth: () => view.container.querySelector("[data-detail-layout-mode]")!.getAttribute("data-detail-content-width"),
    };
  }

  function loadAt(image: HTMLImageElement, width: number, height: number) {
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    fireEvent.load(image);
  }

  it("takes a 16:9 original's proportion over a stored 1077 × 1500, the controls at the picture's corner", () => {
    const stored = pictureBlock(1077, 1500);
    const { frame, preview, original, container, contentWidth } = renderPicture(stored);
    expect(frame.style.aspectRatio).toBe("1077 / 1500");
    expect(contentWidth()).toBe(String(detailContentFullWidth(stored, window.innerHeight)));
    // The preview's sides are rounded: it never corrects the frame.
    loadAt(preview, 640, 360);
    expect(frame.style.aspectRatio).toBe("1077 / 1500");

    loadAt(original, 1920, 1080);
    expect(frame.style.aspectRatio).toBe("1920 / 1080");
    expect(frame.style.width).toBe("min(1920px, calc(var(--detail-media-max-height) * 1920 / 1080))");
    expect(original).toHaveClass("absolute", "inset-0", "size-full", "object-contain");
    // The content's width follows the corrected frame (Р1): the reading
    // column, which a 16:9 picture under the height limit fills.
    expect(contentWidth()).toBe(String(DETAIL_CONTENT_MAX_WIDTH_PX));
    // The controls stand in the box that shrinks to the frame, so at the
    // corner of the picture, not over the empty space of a portrait frame.
    const controls = container.querySelector("[data-detail-media-action-menu]")!;
    expect(controls).toHaveClass("absolute", "right-2", "top-2");
    expect(controls.parentElement).toBe(frame.parentElement);
    expect(frame.parentElement).toHaveClass("inline-flex", "max-w-full");
  });

  it("keeps the recorded frame when the original's proportion is within the tolerance", () => {
    const stored = pictureBlock(1600, 1200);
    const { frame, original, contentWidth } = renderPicture(stored);
    const geometry = frame.getAttribute("style");
    const width = contentWidth();
    // 1601 × 1200 against 1600 × 1200: 0.06 %, under the 1 % tolerance.
    loadAt(original, 1601, 1200);
    expect(frame.getAttribute("style")).toBe(geometry);
    expect(frame.style.aspectRatio).toBe("1600 / 1200");
    expect(contentWidth()).toBe(width);
  });
});
