import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EmbeddedVideoPreview } from "./lib/messaging";
import { normalizeArticleMedia } from "./lib/normalizeArticleMedia";
import objktVideo from "./lib/fixtures/objkt-video.json";

const { state } = vi.hoisted(() => ({ state: {
  state: "main", saveMode: "app", currentType: "content", articleExtractionState: "ready",
  metadata: { url: "https://x.com/home", title: "Repost", selection: "", detectedType: "content", image: null as string | null },
  articleData: { content: "sketching the landscape", threadWarning: "Open the original X post to collect its thread.", embeddedVideos: [] as EmbeddedVideoPreview[] },
  channels: [], selectedTags: [], saving: false, savePinned: false, canSave: true, draftReady: true, nativeStatusError: null,
  draftError: null as string | null, draftLoading: false,
  channelsLoading: false, channelsError: null as string | null, retryChannels: vi.fn(),
  save: vi.fn(), setCurrentType: vi.fn(), toggleTag: vi.fn(), createChannel: vi.fn(),
} }));
vi.mock("./hooks/useClipperState", () => ({ useClipperState: () => state }));
import { PopupApp } from "./PopupApp";

beforeEach(() => {
  state.save.mockReset();
  state.channelsLoading = false;
  state.channelsError = null;
  state.retryChannels.mockReset();
  state.draftReady = true;
  state.canSave = true;
  state.savePinned = false;
  state.draftError = null;
  state.draftLoading = false;
  state.articleData.content = "sketching the landscape";
  state.articleData.embeddedVideos = [];
  state.metadata.url = "https://x.com/home";
  state.metadata.image = null;
});
describe("clipper preview", () => {
  it("locks edits but keeps Save available for a prepared journal confirmation", () => {
    state.savePinned = true;
    const { container } = render(<PopupApp />);
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    const fieldsets = container.querySelectorAll("fieldset");
    expect(fieldsets.length).toBeGreaterThan(0);
    fieldsets.forEach(fieldset => expect(fieldset).toBeDisabled());
  });
  it("keeps Save available when recovery storage is unavailable", () => {
    state.draftError = "Edits are kept in this open clipper. Save will store the clip shown here.";
    render(<PopupApp />);
    expect(screen.getByRole("status")).toHaveTextContent(state.draftError);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });
  it("distinguishes loading collections from an empty collection list", () => {
    state.channelsLoading = true;
    render(<PopupApp />);
    expect(screen.getByText("Loading collections...")).toBeInTheDocument();
    expect(screen.queryByText("No collections")).not.toBeInTheDocument();
  });
  it("offers retry on collection failure without blocking saving", () => {
    state.channelsError = "Could not load collections.";
    render(<PopupApp />);
    expect(screen.getByText(state.channelsError)).toBeInTheDocument();
    expect(screen.queryByText("No collections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.retryChannels).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });
  it("shows an empty list only after a successful load", () => {
    render(<PopupApp />);
    expect(screen.getByText("No collections")).toBeInTheDocument();
  });
  it("keeps Save available while recovery restoration is pending", () => {
    state.draftReady = false;
    state.draftLoading = true;
    const view = render(<PopupApp />);
    const button = screen.getByRole("button", { name: "Save", exact: true });
    expect(button).toBeEnabled();
    state.draftReady = true;
    view.rerender(<PopupApp />);
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });
  it("shows each X video's own poster and never substitutes the page promo image", () => {
    state.metadata.url = "https://x.com/artist/status/123";
    state.metadata.image = "https://example.com/x-promo.jpg";
    state.articleData.embeddedVideos = [
      { src: "https://video.twimg.com/tweet_video/first.mp4", poster: "https://pbs.twimg.com/tweet_video_thumb/first.jpg", title: "First" },
      { src: "https://video.twimg.com/tweet_video/second.mp4", poster: null, title: "Second" },
    ];
    const { container } = render(<PopupApp />);
    expect(screen.getByLabelText("First")).toBeInTheDocument();
    expect(screen.getByLabelText("Second")).toBeInTheDocument();
    expect(container.querySelector('img[src="https://pbs.twimg.com/tweet_video_thumb/first.jpg"]')).not.toBeNull();
    expect(container.querySelector('img[src="https://example.com/x-promo.jpg"]')).toBeNull();
  });
  it("renders extensionless objkt media once as video preview, not a broken image", () => {
    const article = normalizeArticleMedia(objktVideo.article, objktVideo.pageUrl);
    state.articleData.content = article.content;
    state.articleData.embeddedVideos = article.embeddedVideos ?? [];
    const { container } = render(<PopupApp />);
    expect(screen.getAllByLabelText("Video preview")).toHaveLength(1);
    expect(container.querySelector(`img[src="${objktVideo.mediaUrl}"]`)).toBeNull();
    expect(screen.getByRole("link", { name: "bach" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });

  it("shows collected content without internal thread warnings or confirmation checkboxes", () => {
    render(<PopupApp />);
    expect(screen.getByText("sketching the landscape")).toBeInTheDocument();
    expect(screen.queryByText(state.articleData.threadWarning)).not.toBeInTheDocument();
    expect(screen.queryByText("Save only the loaded part")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });
  it("still shows a real save failure", async () => {
    state.save.mockResolvedValue({ ok: false, error: "Could not write the file." });
    render(<PopupApp />);
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(await screen.findByText("Could not write the file.")).toBeInTheDocument();
  });
});

describe("clipper keyboard (А6.9)", () => {
  beforeEach(() => {
    state.setCurrentType.mockReset();
    state.currentType = "content";
  });

  it("leaves Tab to move focus and never changes the type with it", () => {
    render(<PopupApp />);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(state.setCurrentType).not.toHaveBeenCalled();
  });

  it("changes the type with the arrows, around the ring", () => {
    render(<PopupApp />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(state.setCurrentType).toHaveBeenLastCalledWith("screenshot");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(state.setCurrentType).toHaveBeenLastCalledWith("link");
  });

  it("moves focus with the choice when a type segment has it", () => {
    render(<PopupApp />);
    const content = screen.getByRole("button", { name: "Content" });
    content.focus();
    fireEvent.keyDown(content, { key: "ArrowRight" });
    expect(state.setCurrentType).toHaveBeenLastCalledWith("screenshot");
    expect(screen.getByRole("button", { name: "Screenshot" })).toHaveFocus();
  });

  it("keeps the arrows for the caret in a text field", () => {
    render(<PopupApp />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(state.setCurrentType).not.toHaveBeenCalled();
    field.remove();
  });
});
