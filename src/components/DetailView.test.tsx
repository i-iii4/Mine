import { render, screen } from "@testing-library/react";
import { Suspense, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detail = vi.hoisted(() => ({
  preloadNoteEditor: vi.fn(() => Promise.resolve()),
}));

vi.mock("./Detail", () => ({
  Detail: ({ block }: { block: { slug: string } }) => <div data-testid="open-card">{block.slug}</div>,
  preloadNoteEditor: detail.preloadNoteEditor,
}));

const { DetailView, preloadDetail } = await import("./DetailView");

type DetailProps = ComponentProps<typeof DetailView>;
// The stand-in reads the slug alone; the rest of the card's props do not
// reach it.
const props = { block: { slug: "card" } } as unknown as DetailProps;

/// The open card's part of the bundle (SPEC_CARD_PEEK.md, О12): through a
/// Suspense boundary until its module is loaded, at once after.
describe("DetailView", () => {
  it("waits for the module the first time, then renders the card at once", async () => {
    const first = render(
      <Suspense fallback={<div data-testid="waiting" />}>
        <DetailView {...props} />
      </Suspense>,
    );
    expect(await screen.findByTestId("open-card")).toHaveTextContent("card");
    first.unmount();

    // Loaded: no boundary is needed, nothing suspends.
    render(<DetailView {...props} />);
    expect(screen.getByTestId("open-card")).toHaveTextContent("card");
  });

  it("loads the module and its editor ahead of the first card", async () => {
    await preloadDetail();
    expect(detail.preloadNoteEditor).toHaveBeenCalledTimes(1);
  });
});

/// The parts load ahead of the first card after the page's first cards,
/// whatever view the card opens in (SPEC_READING_MODE.md, Ч0.6).
describe("preloadDetailAfterFirstCards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Its own page each time: the first cards are painted once per page.
    vi.resetModules();
    detail.preloadNoteEditor.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The page's modules, new: nothing painted, nothing loaded. */
  async function page() {
    const view = await import("./DetailView");
    const startup = await import("@/lib/startup");
    return { ...view, ...startup };
  }

  /** Two frames: the load starts a frame after the one that shows the cards. */
  async function passFrames() {
    await vi.advanceTimersToNextFrame();
    await vi.advanceTimersToNextFrame();
  }

  it("waits for the first cards, then loads both parts a frame later", async () => {
    const { preloadDetailAfterFirstCards, reportCardsRendered, whenDetailPreloaded } = await page();
    let preloaded = false;
    void whenDetailPreloaded().then(() => {
      preloaded = true;
    });
    preloadDetailAfterFirstCards();
    await passFrames();
    expect(detail.preloadNoteEditor).not.toHaveBeenCalled();

    reportCardsRendered();
    await vi.advanceTimersByTimeAsync(0);
    // Not inside the frame that shows the cards.
    expect(detail.preloadNoteEditor).not.toHaveBeenCalled();
    await passFrames();
    await vi.advanceTimersByTimeAsync(0);
    expect(detail.preloadNoteEditor).toHaveBeenCalledTimes(1);
    expect(preloaded).toBe(true);
  });

  it("loads them when the page paints no cards, once the first cards' budget has passed", async () => {
    const { preloadDetailAfterFirstCards, DETAIL_PRELOAD_LATEST_MS } = await page();
    preloadDetailAfterFirstCards();
    await vi.advanceTimersByTimeAsync(DETAIL_PRELOAD_LATEST_MS - 1);
    expect(detail.preloadNoteEditor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await passFrames();
    await vi.advanceTimersByTimeAsync(0);
    expect(detail.preloadNoteEditor).toHaveBeenCalledTimes(1);
  });

  it("loads them once when the cards come after the wait has run out", async () => {
    const { preloadDetailAfterFirstCards, reportCardsRendered, DETAIL_PRELOAD_LATEST_MS } = await page();
    preloadDetailAfterFirstCards();
    await vi.advanceTimersByTimeAsync(DETAIL_PRELOAD_LATEST_MS);
    await passFrames();
    reportCardsRendered();
    await passFrames();
    await vi.advanceTimersByTimeAsync(0);
    expect(detail.preloadNoteEditor).toHaveBeenCalledTimes(1);
  });

  it("loads nothing once called off", async () => {
    const { preloadDetailAfterFirstCards, reportCardsRendered, DETAIL_PRELOAD_LATEST_MS } = await page();
    const callOff = preloadDetailAfterFirstCards();
    reportCardsRendered();
    await vi.advanceTimersByTimeAsync(0);
    callOff();
    await passFrames();
    await vi.advanceTimersByTimeAsync(DETAIL_PRELOAD_LATEST_MS);
    await passFrames();
    expect(detail.preloadNoteEditor).not.toHaveBeenCalled();
  });
});
