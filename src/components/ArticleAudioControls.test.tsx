import type { ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ArticleAudioGatewayProvider,
  type ArticleAudioGateway,
} from "@/lib/articleAudioGateway";
import type { ArticleAudioState } from "@/types";
import { ArticleAudioControls } from "./ArticleAudioControls";

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

const articleAudioGateway = {
  getState: vi.fn<(...args: [string]) => Promise<typeof ABSENT_STATE | typeof READY_STATE>>(),
  generate: vi.fn<(...args: [string]) => Promise<typeof ABSENT_STATE | typeof READY_STATE>>(),
  remove: vi.fn<(...args: [string]) => Promise<void>>(),
  setPosition: vi.fn<(...args: [string, number, number | null, boolean]) => Promise<void>>(),
  resolvePlaybackSource: vi.fn((state: ArticleAudioState) =>
    state.status === "ready" && state.audio_path
      ? { url: state.audio_path }
      : null,
  ),
  subscribe: vi.fn(async () => vi.fn()),
} satisfies ArticleAudioGateway;

function renderWithGateway(ui: ReactElement) {
  return render(
    <ArticleAudioGatewayProvider gateway={articleAudioGateway}>
      {ui}
    </ArticleAudioGatewayProvider>,
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
    articleAudioGateway.resolvePlaybackSource.mockImplementation((state: ArticleAudioState) =>
      state.status === "ready" && state.audio_path
        ? { url: state.audio_path }
        : null,
    );
    articleAudioGateway.subscribe.mockResolvedValue(vi.fn());
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
    vi.clearAllMocks();
  });

  it("creates audio and then renders remove and play controls", async () => {
    articleAudioGateway.getState.mockResolvedValueOnce(ABSENT_STATE);
    articleAudioGateway.generate.mockResolvedValueOnce(READY_STATE);

    renderWithGateway(<ArticleAudioControls slug="essay" blockType="article" url={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Audio" }));

    await waitFor(() => {
      expect(articleAudioGateway.generate).toHaveBeenCalledWith("essay");
      expect(fetchMock).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Remove Audio" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });
  });

  it("shows retry after generation failure", async () => {
    articleAudioGateway.getState.mockResolvedValueOnce(ABSENT_STATE);
    articleAudioGateway.generate.mockRejectedValueOnce(
      new Error("Speech synthesis failed"),
    );

    renderWithGateway(<ArticleAudioControls slug="essay" blockType="article" url={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Audio" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.getByText("Speech synthesis failed")).toBeInTheDocument();
    });
  });

  it("resumes from stored position and removes audio while playing", async () => {
    articleAudioGateway.getState.mockResolvedValueOnce(READY_STATE);
    articleAudioGateway.remove.mockResolvedValueOnce();

    renderWithGateway(<ArticleAudioControls slug="essay" blockType="article" url={null} />);

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
      expect(articleAudioGateway.remove).toHaveBeenCalledWith("essay");
      expect(screen.getByRole("button", { name: "Create Audio" })).toBeInTheDocument();
    });
  });

  it("persists playback position after decode and on unmount", async () => {
    articleAudioGateway.getState.mockResolvedValueOnce({
      ...READY_STATE,
      duration_ms: null,
    });
    articleAudioGateway.setPosition.mockResolvedValue();

    const { unmount } = renderWithGateway(
      <ArticleAudioControls slug="essay" blockType="article" url={null} />,
    );

    await waitFor(() => {
      expect(articleAudioGateway.setPosition).toHaveBeenCalledWith("essay", 4_200, 12_000, false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    mockContext.currentTime = 1.9;
    unmount();

    await waitFor(() => {
      expect(articleAudioGateway.setPosition).toHaveBeenLastCalledWith("essay", 6_100, 12_000, false);
    });
  });

  it("hides itself for social article URLs", () => {
    articleAudioGateway.getState.mockResolvedValue(ABSENT_STATE);

    const { container } = renderWithGateway(
      <ArticleAudioControls
        slug="tweet"
        blockType="article"
        url="https://x.com/user/status/123"
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(articleAudioGateway.getState).not.toHaveBeenCalled();
  });
});
