import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContext } from "react";
import { SIDEBAR_OVERLAY_LABEL, SIDEBAR_OVERLAY_MOTION_MS, SidebarOverlay, SidebarOverlayWidthContext } from "./SidebarOverlay";

/** What a part of the list in the panel lays itself out by. */
function ListWidth() {
  return <output data-testid="list-width">{useContext(SidebarOverlayWidthContext)}</output>;
}

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/lib/motion", () => ({
  motionDuration: (ms: number) => (motion.reduced ? 0 : ms),
}));

function Overlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button type="button">Under the scrim</button>
      <SidebarOverlay
        open={open}
        onClose={onClose}
        header={<input aria-label="Find or create collection" />}
      >
        <a href="#inbox">Inbox</a>
        <ListWidth />
      </SidebarOverlay>
    </>
  );
}

describe("SidebarOverlay: the sidebar over the feed (SPEC_NARROW_WINDOW.md, У4 по У6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    motion.reduced = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a dialog with its filter row and list over a scrim, the window less the strip wide", () => {
    const { container } = render(<Overlay open onClose={vi.fn()} />);
    const panel = screen.getByRole("dialog", { name: SIDEBAR_OVERLAY_LABEL });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toContainElement(screen.getByRole("textbox", { name: "Find or create collection" }));
    expect(panel).toContainElement(screen.getByRole("link", { name: "Inbox" }));
    // jsdom drops `min()` from `width`; the list in the panel is laid out by
    // the same width, which it takes from the panel (sidebarWidth.ts).
    expect(screen.getByTestId("list-width")).toHaveTextContent("min(600px, 100vw - 40px)");
    expect(container.querySelector("[data-sidebar-overlay-scrim]")).not.toBeNull();
  });

  it("closes on the scrim and the strip, not inside the panel (У6)", () => {
    const onClose = vi.fn();
    const { container } = render(<Overlay open onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    const scrim = container.querySelector("[data-sidebar-overlay-scrim]");
    if (!scrim) throw new Error("no scrim");
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and takes it from the card under it (У6)", () => {
    const onClose = vi.fn();
    render(<Overlay open onClose={onClose} />);
    // The open card hears Escape on the document's capture phase.
    const card = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener("keydown", card, true);
    try {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(card).toHaveReturnedWith(true);
    } finally {
      document.removeEventListener("keydown", card, true);
    }
  });

  it("leaves Escape to a field, a menu and another dialog", () => {
    const onClose = vi.fn();
    render(
      <>
        <Overlay open onClose={onClose} />
        <div role="menu"><button type="button" role="menuitem">Rename</button></div>
        <div role="alertdialog"><button type="button">Delete</button></div>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", metaKey: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes the focus on opening and gives it back on closing", () => {
    const { rerender } = render(<Overlay open={false} onClose={vi.fn()} />);
    const under = screen.getByRole("button", { name: "Under the scrim" });
    under.focus();
    rerender(<Overlay open onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
    rerender(<Overlay open={false} onClose={vi.fn()} />);
    expect(under).toHaveFocus();
  });

  it("keeps the focus the page put inside it (⇧⌘F, У11)", () => {
    function FocusFilter() {
      return (
        <SidebarOverlay
          open
          onClose={vi.fn()}
          header={<input aria-label="Filter" autoFocus />}
        >
          {null}
        </SidebarOverlay>
      );
    }
    render(<FocusFilter />);
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
  });

  it("moves out over 200 ms, at once with reduced motion", () => {
    const { rerender } = render(<Overlay open onClose={vi.fn()} />);
    act(() => vi.advanceTimersToNextFrame());
    expect(document.querySelector("[data-sidebar-overlay]")).toHaveAttribute("data-state", "open");

    rerender(<Overlay open={false} onClose={vi.fn()} />);
    expect(document.querySelector("[data-sidebar-overlay]")).toHaveAttribute("data-state", "closed");
    act(() => vi.advanceTimersByTime(SIDEBAR_OVERLAY_MOTION_MS - 1));
    expect(document.querySelector("[data-sidebar-overlay]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector("[data-sidebar-overlay]")).toBeNull();

    motion.reduced = true;
    rerender(<Overlay open onClose={vi.fn()} />);
    rerender(<Overlay open={false} onClose={vi.fn()} />);
    expect(document.querySelector("[data-sidebar-overlay]")).toBeNull();
  });
});
