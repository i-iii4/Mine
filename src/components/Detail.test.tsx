import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Detail, MediaAssetCollectionPicker } from "./Detail";
import type { IndexedBlock, MediaAssetRef } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { COLLECTION_PICKER_CONTENT_CLASS } from "./CollectionPicker";
import { cancelSourceVideoDownload, copyMediaAssetToClipboard, getBlock, icloudDownloadProgress, prepareDeleteMediaAsset, resolveNoteLink, sourceVideoDownloadStatus, startSourceVideoDownload, youtubePlayerUrl } from "@/lib/commands";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
} from "@/lib/hoverPreviewTiming";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

const writeText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

vi.mock("./ArticleAudioControls", () => ({
  ArticleAudioControls: () => <div data-testid="article-audio-controls" />,
}));

vi.mock("./VideoFromBlob", () => ({
  VideoFromBlob: ({
    src,
    controls,
    autoPlay,
    muted,
    loop,
  }: {
    src: string;
    controls?: boolean;
    autoPlay?: boolean;
    muted?: boolean;
    loop?: boolean;
  }) => (
    <video
      data-src={src}
      data-controls={controls ? "true" : "false"}
      data-autoplay={autoPlay ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-loop={loop ? "true" : "false"}
      data-testid="video-from-blob"
    />
  ),
}));

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
  return {
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
    collections: [],
    feed_playback: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
    ...overrides,
  };
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
      sendDownload({ slug: props.block.slug, state: "failed", message: "YouTube refused the download (HTTP 403)." });
      expect(screen.getByText("Download failed: YouTube refused the download (HTTP 403).")).toBeInTheDocument();
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
      referenced_by: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setViewportWidth(initialViewportWidth);
  });

  it.each([false, true])("uses the resolved deletion path and never reports empty references after an error (%s)", async (failure) => {
    if (failure) prepareDeleteMediaAssetMock.mockRejectedValueOnce({ kind: "media_not_found", media_ref: "photo.jpg" });
    else prepareDeleteMediaAssetMock.mockResolvedValueOnce({ media_ref: "Media/photo.jpg", media_kind: "image", referenced_by: [] });
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
      expect(within(dialog).queryByText("No cards currently reference this file.")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Delete media" })).toBeDisabled();
      expect(onDelete).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete media" })).toBeEnabled());
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
      onTagsChanged={vi.fn()} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} />);
    const header = container.querySelector("[data-detail-drag-handle]")!;
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
      />,
    );

    const scrollEl = container.querySelector("[data-detail-scroll]");
    expect(scrollEl).not.toHaveClass("pb-20");
    expect(scrollEl?.firstElementChild).toHaveClass("pb-20");
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
    expect(dateLabel.closest("[data-metadata-row]")).toHaveClass(
      "relative",
      "grid",
      "w-full",
      "grid-cols-[max-content_minmax(0,1fr)]",
      "gap-x-4",
      "pb-2",
      "after:border-border",
    );
    const metadataRows = container.querySelectorAll("[data-metadata-row]");
    expect(metadataRows.length).toBeGreaterThan(0);
    expect(dateLabel.closest("[data-metadata-row]")?.lastElementChild?.firstElementChild).toHaveClass(
      "text-sm",
      "leading-4",
    );
  });

  it("uses one detail canvas grid for content spacer and fixed rail", () => {
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
    const articleColumn = container.querySelector("[data-detail-article-column]");
    expect(articleColumn).toHaveClass("col-start-2", "min-w-0");
    expect(articleColumn).not.toHaveClass("pl-2", "pl-4");
    expect(rail).toHaveClass(
      "col-start-4",
      "min-w-0",
      "overflow-y-auto",
      "overflow-x-hidden",
    );
    const spacer = container.querySelector("[data-detail-metadata-spacer]");
    expect(spacer).toHaveClass("col-start-4", "min-w-0");
    expect(spacer?.parentElement).toHaveClass(
      "w-full",
      "grid",
      "grid-cols-[minmax(var(--card-content-pad),1fr)_minmax(400px,48rem)_minmax(var(--card-content-pad),1fr)_20rem_var(--card-content-pad)]",
      "pt-[var(--card-content-pad)]",
    );
    expect(rail?.parentElement).toHaveClass(
      "w-full",
      "grid",
      "grid-cols-[minmax(var(--card-content-pad),1fr)_minmax(400px,48rem)_minmax(var(--card-content-pad),1fr)_20rem_var(--card-content-pad)]",
      "pt-[var(--card-content-pad)]",
    );
  });

  it("stacks metadata below content once the article would shrink under 400px", async () => {
    setViewportWidth(815);

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
      "grid-cols-[var(--card-content-pad)_minmax(240px,1fr)_var(--card-content-pad)]",
      "pt-[var(--card-content-pad)]",
      "pb-20",
    );
    expect(articleColumn).toHaveClass(
      "col-start-2",
      "mx-auto",
      "w-full",
      "max-w-[48rem]",
    );
    expect(stackedMetadataRow).toHaveClass(
      "col-start-2",
      "mt-[var(--card-content-pad)]",
      "min-w-0",
    );
    expect(container.querySelector("[data-detail-fixed-metadata-layer]")).toBeNull();
    expect(container.querySelector("[data-detail-metadata-spacer]")).toBeNull();
  });

  it("compensates classic detail chrome so article and rail start at the 64px detail inset", () => {
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
    expect(rail?.parentElement).toHaveClass("pt-[var(--card-content-pad)]");
  });

  it("keeps related notes as a separate block below the metadata table", async () => {
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
      expect(label.parentElement).toHaveAttribute("data-related-notes-block");
      expect(label.parentElement).toHaveClass("flex", "flex-col", "gap-1");
      expect(label.parentElement?.parentElement).toHaveAttribute("data-metadata-sections");
      expect(label.parentElement?.parentElement).toHaveClass("gap-6");
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
      expect(screen.getByText("Related Note")).toBeInTheDocument();
    });

    const sections = container.querySelector("[data-metadata-sections]");
    const actionRow = container.querySelector("[data-detail-action-row]");
    const relatedNotesBlock = container.querySelector("[data-related-notes-block]");
    expect(sections).toHaveClass("gap-6");
    expect(actionRow).toHaveClass(
      "min-w-0",
      "flex",
      "items-center",
      "gap-2",
      "px-2",
      "pb-2",
    );
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
      "bg-accent",
    );
    expect(metadataCard).toHaveStyle({ minWidth: "240px" });
    const metadataContent = metadataCard?.querySelector("[data-detail-metadata-card-content]");
    expect(metadataContent).toHaveClass("px-2", "pb-4", "pt-4");
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
      />,
    );

    const paragraphs = container.querySelectorAll("p");
    const secondParagraph = paragraphs[1];
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
    expect(trigger).toHaveClass("button-depth", "rounded-2", "bg-depth-fill");
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        <DropdownMenuContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS}>
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
    expect(within(dialog).getByText("Connected elements")).toBeInTheDocument();
    const connectedCardsScroll = dialog.querySelector("[data-delete-media-connected-cards-scroll]");
    expect(connectedCardsScroll).toHaveAttribute("data-visible-card-count", "5");
    expect(connectedCardsScroll).toHaveStyle({ maxHeight: "216px" });
    expect(within(dialog).queryByText("Primary media")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Inline media")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("2 cards reference this file.")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("photo.jpg")).not.toBeInTheDocument();
    expect(photoRow).toHaveAttribute("data-related-note-item", "button");
    expect(photoRow).toHaveClass("bg-component-fill");
    expect(sourceRow).toHaveAttribute("data-related-note-item", "button");
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
    fireEvent.mouseLeave(photoRow);
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
    const scrollArea = dialog.querySelector("[data-delete-media-connected-cards-scroll]");
    const section = row.closest("[data-related-notes-block]");
    const list = row.closest("[data-related-notes-list]");
    // The row also holds the thumbnail wrapper span, so match the label class
    // rather than the first span in document order.
    const label = row.querySelector("span.flex-1");

    expect(dialog).toHaveClass("min-w-0", "overflow-hidden");
    expect(scrollArea).toHaveClass("min-w-0", "overflow-y-auto");
    expect(section).toHaveClass("min-w-0");
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
        const start = asset.occurrence_index === null ? undefined : openers[asset.occurrence_index];
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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
        onRequestDelete={vi.fn()}
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

  it("renders related notes as sidebar-sized rows with thumbnail and filename", async () => {
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
    expect(screen.getByText("Related Note")).toBeInTheDocument();
    expect(screen.getByText("Second Note")).toBeInTheDocument();
    expect(screen.queryByText("First line from note body")).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: "Related Note" });
    expect(row).toHaveAttribute("data-related-note-item", "button");
    expect(row).toHaveClass(
      "rounded-1",
      "border",
      "border-border",
      "bg-component-fill",
      "p-[3px]",
      "font-sans",
      "text-base",
      "text-muted-foreground",
    );
    expect(row).toHaveClass(
      "hover:outline-1",
      "hover:-outline-offset-1",
      "hover:outline-component-fill-hover",
      "focus-visible:outline-1",
      "focus-visible:-outline-offset-1",
      "focus-visible:outline-component-fill-hover",
    );

    const img = row.querySelector("img");
    // A related-note row is 32 pixels like the sidebar strip, so it reads the
    // micro level rather than the 640px thumbnail behind it.
    expect(img).toHaveAttribute(
      "src",
      "asset://localhost//tmp/thumbs/related-note.micro.jpg?m=123",
    );
    expect(img).toHaveClass("dark:invert");
    expect(row.querySelector("div.flex.h-8.w-full.items-center.gap-2.overflow-hidden")).not.toBeNull();

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
    expect(relatedPreview).not.toHaveTextContent("Connect");
    expect(document.querySelector("[data-related-note-hover-bridge]")).not.toBeInTheDocument();

    const secondRow = screen.getByRole("button", { name: "Second Note" });
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

    const row = screen.getByRole("button", { name: "Related Note" });
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

    window.dispatchEvent(new Event("vault-refreshed"));

    await waitFor(() => {
      expect(screen.getByText("Related notes")).toBeInTheDocument();
      expect(screen.getByText("Related Note")).toBeInTheDocument();
    });
    expect(screen.queryByText("First line from note body")).not.toBeInTheDocument();
  });

  // A file whose contents iCloud is holding is a state of the file, not a
  // broken card. See SPEC_CLOUD_STORAGE.md Х9, Х11.
  function cloudImageProps(contentInCloud: boolean) {
    return {
      block: block({
        card_kind: "media" as const,
        block_type: "image" as const,
        title: "Photo",
        url: null,
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
