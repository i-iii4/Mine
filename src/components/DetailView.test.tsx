import { render, screen } from "@testing-library/react";
import { Suspense, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

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
