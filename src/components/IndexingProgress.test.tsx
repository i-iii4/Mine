// Numbers, a moving bar, and no lies at the edges; one card for the whole
// opening of a space (О13).

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import {
  INDEXING_NOTICE_DELAY_MS,
  IndexingProgress,
  openingStep,
  useIndexingNotice,
  type IndexingCount,
  type IndexingStep,
} from "./IndexingProgress";

function notes(processed: number, total: number): IndexingStep {
  return { phase: "notes", count: { processed, total } };
}

describe("IndexingProgress", () => {
  it("counts the work out loud", () => {
    render(<IndexingProgress spaceName="Mine" step={notes(1284, 3000)} onClose={() => {}} />);
    expect(screen.getByText("Indexing “Mine”")).toBeInTheDocument();
    expect(screen.getByText("1284 / 3000")).toBeInTheDocument();
  });

  it("draws the bar with the shared Progress, moved by transform (Г5.4)", () => {
    render(<IndexingProgress spaceName="Mine" step={notes(1500, 3000)} onClose={() => {}} />);
    const bar = screen.getByRole("progressbar", { name: "Indexing “Mine”" });
    expect(bar).toHaveAttribute("data-slot", "progress");
    expect(bar).toHaveAttribute("data-progress-mode", "determinate");
    const fill = bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill).not.toBeNull();
    // A pill fill inside a pill track, and the fill slides rather than
    // resizing: no width is animated (DESIGN_SYSTEM.md, Progress).
    expect(bar.className).toContain("rounded-pill");
    expect(fill?.className).toContain("rounded-pill");
    expect(fill?.style.transform).toBe("translateX(-50%)");
    expect(fill?.style.width).toBe("");
    expect(fill?.className).not.toContain("transition-[width]");
  });

  it("never draws past the end, whatever the numbers say", () => {
    render(<IndexingProgress spaceName="Mine" step={notes(5000, 3000)} onClose={() => {}} />);
    const fill = screen.getByRole("progressbar")
      .querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill?.style.transform).toBe("translateX(-0%)");
  });

  it("is a progress bar a screen reader can read (А6.14)", () => {
    render(<IndexingProgress spaceName="Mine" step={notes(1284, 3000)} onClose={() => {}} />);
    const bar = screen.getByRole("progressbar", { name: "Indexing “Mine”" });
    expect(bar).toHaveAttribute("aria-valuenow", "1284");
    expect(bar).toHaveAttribute("aria-valuemax", "3000");
    expect(bar).toHaveAttribute("aria-valuetext", "1284 of 3000");
  });

  it("announces the progress politely, in tenths", () => {
    const { rerender } = render(<IndexingProgress spaceName="Mine" step={notes(1284, 3000)} onClose={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Indexing “Mine”: 40%");

    // Counts inside the same tenth say nothing new.
    rerender(<IndexingProgress spaceName="Mine" step={notes(1290, 3000)} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing “Mine”: 40%");

    rerender(<IndexingProgress spaceName="Mine" step={notes(1500, 3000)} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing “Mine”: 50%");
  });

  it("stays empty for an empty total instead of dividing by it", () => {
    render(<IndexingProgress spaceName="Mine" step={notes(0, 0)} onClose={() => {}} />);
    const fill = screen.getByRole("progressbar")
      .querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill?.style.transform).toBe("translateX(-100%)");
  });

  it("offers another folder while the count shows what this one holds (О12)", () => {
    const onChooseAnother = vi.fn();
    render(<IndexingProgress spaceName="Documents" step={notes(25, 3000)} onClose={() => {}} onChooseAnother={onChooseAnother} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    expect(onChooseAnother).toHaveBeenCalledOnce();
  });

  it("is a notification card in the corner, digits in the interface's font", () => {
    const onClose = vi.fn();
    const { container } = render(<IndexingProgress spaceName="Mine" step={notes(1284, 3000)} onClose={onClose} />);
    expect(container.querySelector("[data-notification-card]")).not.toBeNull();
    const count = screen.getByText("1284 / 3000");
    expect(count).toHaveClass("text-sm", "tabular-nums");
    expect(count).not.toHaveClass("font-mono");
    expect(screen.queryByRole("button", { name: "Choose another folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("counts the previews with the same bar and the same voice", () => {
    render(
      <IndexingProgress
        spaceName="Mine"
        step={{ phase: "previews", count: { processed: 321, total: 643 } }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Preparing previews")).toBeInTheDocument();
    expect(screen.getByText("321 / 643")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Preparing previews" });
    expect(bar).toHaveAttribute("aria-valuenow", "321");
    expect(bar).toHaveAttribute("aria-valuemax", "643");
    expect(bar).toHaveAttribute("aria-valuetext", "321 of 643");
    expect(screen.getByRole("status")).toHaveTextContent("Preparing previews: 40%");
  });

  it("shows no number while the previews are still being counted", () => {
    const { container } = render(
      <IndexingProgress spaceName="Mine" step={{ phase: "previews", count: null }} onClose={() => {}} />,
    );
    const bar = screen.getByRole("progressbar", { name: "Preparing previews" });
    expect(bar).toHaveAttribute("data-progress-mode", "indeterminate");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(container.querySelector("[data-indexing-progress-count]")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing previews");
  });

  it("shows only a pass that runs past the delay, and stays hidden once hidden", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ active }: { active: boolean }) => useIndexingNotice(active),
        { initialProps: { active: true } },
      );
      expect(result.current.visible).toBe(false);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS - 1));
      expect(result.current.visible).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.visible).toBe(true);
      act(() => result.current.hide());
      expect(result.current.visible).toBe(false);
      rerender({ active: true });
      expect(result.current.visible).toBe(false);

      // A short pass ends before the delay and never shows.
      rerender({ active: false });
      rerender({ active: true });
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS / 2));
      rerender({ active: false });
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      expect(result.current.visible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("openingStep", () => {
  const count: IndexingCount = { processed: 3, total: 9 };

  it("shows the notes first, even with a preview pass already queued", () => {
    expect(openingStep(count, true, { processed: 1, total: 9 })).toEqual({ phase: "notes", count });
  });

  it("shows the previews once the notes are done, counted or not yet", () => {
    expect(openingStep(null, true, count)).toEqual({ phase: "previews", count });
    expect(openingStep(null, true, null)).toEqual({ phase: "previews", count: null });
  });

  it("shows nothing once neither phase runs", () => {
    expect(openingStep(null, false, null)).toBeNull();
  });
});

// The notice as App composes it: one opening, two phases, one card.
interface OpeningState {
  notes: IndexingCount | null;
  previewsPending: boolean;
  previews: IndexingCount | null;
}

function Opening({ notes: notesCount, previewsPending, previews }: OpeningState) {
  const step = openingStep(notesCount, previewsPending, previews);
  const notice = useIndexingNotice(step !== null);
  return (
    <div data-testid="corner">
      {notice.visible && step !== null && (
        <IndexingProgress spaceName="Mine" step={step} onClose={notice.hide} />
      )}
    </div>
  );
}

const idle: OpeningState = { notes: null, previewsPending: false, previews: null };

function cards(): NodeListOf<Element> {
  return screen.getByTestId("corner").querySelectorAll("[data-notification-card]");
}

// The phase of the one card in the corner; null when there is none, or more than one.
function shownPhase(): string | null {
  const shown = cards();
  return shown.length === 1 ? shown[0]!.querySelector("[data-indexing-progress]")?.getAttribute("data-indexing-phase") ?? null : null;
}

describe("the opening notice across both phases", () => {
  function withFakeTimers(run: () => void) {
    vi.useFakeTimers();
    try {
      run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("passes from notes to previews in one card that never leaves the corner", () => {
    withFakeTimers(() => {
      const { rerender } = render(<Opening {...idle} notes={{ processed: 10, total: 643 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      expect(screen.getByText("Indexing “Mine”")).toBeInTheDocument();
      expect(cards()).toHaveLength(1);

      // The preview pass is queued while the last notes are counted.
      rerender(<Opening notes={{ processed: 643, total: 643 }} previewsPending previews={null} />);
      expect(shownPhase()).toBe("notes");

      // The notes are done; the previews have not counted their cards yet.
      rerender(<Opening notes={null} previewsPending previews={null} />);
      expect(shownPhase()).toBe("previews");
      expect(screen.getByRole("progressbar", { name: "Preparing previews" })).toBeInTheDocument();
      expect(screen.queryByText("Indexing “Mine”")).toBeNull();

      rerender(<Opening notes={null} previewsPending previews={{ processed: 120, total: 643 }} />);
      expect(cards()).toHaveLength(1);
      expect(screen.getByText("120 / 643")).toBeInTheDocument();

      rerender(<Opening {...idle} />);
      expect(cards()).toHaveLength(0);
    });
  });

  it("counts the delay from the start of the opening, not of each phase", () => {
    withFakeTimers(() => {
      const { rerender } = render(<Opening {...idle} notes={{ processed: 1, total: 643 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS * 0.6));
      expect(cards()).toHaveLength(0);

      // Indexing ends short of the delay; the previews carry the opening on.
      rerender(<Opening notes={null} previewsPending previews={{ processed: 0, total: 643 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS * 0.4));
      expect(shownPhase()).toBe("previews");
    });
  });

  it("never shows an opening whose both phases end within the delay", () => {
    withFakeTimers(() => {
      const { rerender } = render(<Opening {...idle} notes={{ processed: 1, total: 20 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS * 0.4));
      rerender(<Opening notes={null} previewsPending previews={{ processed: 5, total: 20 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS * 0.4));
      rerender(<Opening {...idle} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      expect(cards()).toHaveLength(0);
    });
  });

  it("stays hidden through the previews once hidden, and returns with the next opening", () => {
    withFakeTimers(() => {
      const { rerender } = render(<Opening {...idle} notes={{ processed: 10, total: 643 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(cards()).toHaveLength(0);

      rerender(<Opening notes={null} previewsPending previews={{ processed: 300, total: 643 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      expect(cards()).toHaveLength(0);

      // Both phases end; the next long opening is shown again.
      rerender(<Opening {...idle} />);
      rerender(<Opening notes={null} previewsPending previews={{ processed: 1, total: 643 }} />);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      expect(shownPhase()).toBe("previews");
    });
  });
});
