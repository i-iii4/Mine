import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArticleAudioControls } from "./ArticleAudioControls";

vi.mock("@/lib/commands", () => ({
  getArticleAudioState: vi.fn(),
  generateArticleAudio: vi.fn(),
  deleteArticleAudio: vi.fn(),
  setArticleAudioPosition: vi.fn(),
}));

import {
  deleteArticleAudio,
  generateArticleAudio,
  getArticleAudioState,
  setArticleAudioPosition,
} from "@/lib/commands";

const ABSENT_STATE = {
  status: "absent" as const,
  audio_path: null,
  duration_ms: null,
  last_position_ms: 0,
  completed_at: null,
};

const READY_STATE = {
  status: "ready" as const,
  audio_path: "/tmp/audio/essay.wav",
  duration_ms: 10_000,
  last_position_ms: 4_200,
  completed_at: null,
};

class MockBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  destination = {};
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createBufferSource = vi.fn(() => new MockBufferSource() as unknown as AudioBufferSourceNode);
  decodeAudioData = vi.fn(
    async () =>
      ({
        duration: 12,
      }) as AudioBuffer,
  );
}

describe("ArticleAudioControls", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let mockContext: MockAudioContext;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    mockContext = new MockAudioContext();
    vi.stubGlobal("fetch", fetchMock);
    function MockAudioContextConstructor() {
      return mockContext as unknown as AudioContext;
    }
    vi.stubGlobal(
      "AudioContext",
      MockAudioContextConstructor as unknown as typeof AudioContext,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("creates audio and then renders remove and play controls", async () => {
    vi.mocked(getArticleAudioState).mockResolvedValueOnce(ABSENT_STATE);
    vi.mocked(generateArticleAudio).mockResolvedValueOnce(READY_STATE);

    render(<ArticleAudioControls slug="essay" blockType="article" url={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Audio" }));

    await waitFor(() => {
      expect(generateArticleAudio).toHaveBeenCalledWith("essay");
      expect(fetchMock).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Remove Audio" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });
  });

  it("shows retry after generation failure", async () => {
    vi.mocked(getArticleAudioState).mockResolvedValueOnce(ABSENT_STATE);
    vi.mocked(generateArticleAudio).mockRejectedValueOnce(
      new Error("Speech synthesis failed"),
    );

    render(<ArticleAudioControls slug="essay" blockType="article" url={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Audio" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.getByText("Speech synthesis failed")).toBeInTheDocument();
    });
  });

  it("resumes from stored position and removes audio while playing", async () => {
    vi.mocked(getArticleAudioState).mockResolvedValueOnce(READY_STATE);
    vi.mocked(deleteArticleAudio).mockResolvedValueOnce();

    render(<ArticleAudioControls slug="essay" blockType="article" url={null} />);

    await screen.findByRole("button", { name: "Play" });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => {
      const source = mockContext.createBufferSource.mock.results.at(-1)?.value as unknown as MockBufferSource;
      expect(source.start).toHaveBeenCalledWith(0, 4.2);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove Audio" }));

    await waitFor(() => {
      const source = mockContext.createBufferSource.mock.results.at(-1)?.value as unknown as MockBufferSource;
      expect(source.stop).toHaveBeenCalled();
      expect(deleteArticleAudio).toHaveBeenCalledWith("essay");
      expect(screen.getByRole("button", { name: "Create Audio" })).toBeInTheDocument();
    });
  });

  it("persists playback position after decode and on unmount", async () => {
    vi.mocked(getArticleAudioState).mockResolvedValueOnce({
      ...READY_STATE,
      duration_ms: null,
    });
    vi.mocked(setArticleAudioPosition).mockResolvedValue();

    const { unmount } = render(
      <ArticleAudioControls slug="essay" blockType="article" url={null} />,
    );

    await waitFor(() => {
      expect(setArticleAudioPosition).toHaveBeenCalledWith("essay", 4_200, 12_000, false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    mockContext.currentTime = 1.9;
    unmount();

    await waitFor(() => {
      expect(setArticleAudioPosition).toHaveBeenLastCalledWith("essay", 6_100, 12_000, false);
    });
  });

  it("hides itself for social article URLs", () => {
    vi.mocked(getArticleAudioState).mockResolvedValue(ABSENT_STATE);

    const { container } = render(
      <ArticleAudioControls
        slug="tweet"
        blockType="article"
        url="https://x.com/user/status/123"
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(getArticleAudioState).not.toHaveBeenCalled();
  });
});
