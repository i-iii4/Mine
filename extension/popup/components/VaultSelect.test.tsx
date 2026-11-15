import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENU_BLINK_ATTRIBUTE, setMenuBlinkMsForTests } from "@/lib/menuBlink";
import { MOTION_MENU_BLINK_MS } from "@/lib/motion";
import { VaultSelect } from "./VaultSelect";

const CURRENT = "/Users/x/Spaces/Mine";
const OTHER = "/Users/x/Spaces/Journal";

function trigger() {
  return screen.getByRole("button", { name: /Switch space: Mine/ });
}

/** A pointer press and the click a browser sends after it. */
function pointerClick(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(target, { button: 0, pointerId: 1 });
  fireEvent.click(target, { detail: 1 });
}

async function openMenu() {
  pointerClick(trigger());
  await screen.findByRole("menuitem", { name: "Journal" });
}

function renderSelect(overrides: Partial<Parameters<typeof VaultSelect>[0]> = {}) {
  const props = {
    value: CURRENT,
    options: [CURRENT, OTHER],
    onChange: vi.fn(),
    onReveal: vi.fn(),
    onAddSpace: vi.fn(),
    ...overrides,
  };
  render(<VaultSelect {...props} />);
  return props;
}

describe("VaultSelect", () => {
  // The name is part of the header the overlay is dragged by (SPEC_CLIPPER.md,
  // Р10): the pointer opens the menu on the click, not on the press.
  it("opens on the click that follows a pointer press, not on the press", async () => {
    renderSelect();
    fireEvent.pointerDown(trigger(), { button: 0, pointerId: 1 });
    expect(screen.queryByRole("menuitem", { name: "Journal" })).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerUp(trigger(), { button: 0, pointerId: 1 });
    fireEvent.click(trigger(), { detail: 1 });
    expect(await screen.findByRole("menuitem", { name: "Journal" })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("data-clipper-drag-control");
  });

  it("shuts on a click of the name while open", async () => {
    renderSelect();
    await openMenu();
    pointerClick(trigger());
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Journal" })).not.toBeInTheDocument());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  // A long name is cut as the app's space switcher cuts it: an ellipsis
  // before the chevron, short of "…" and the close button (SPEC_CLIPPER.md,
  // Р10, 11.10.2026). The layout itself is measured in the built extension
  // (clipper-worker-smoke.mjs); here the markup that gives it.
  it("cuts a long name with an ellipsis before its chevron, short of the header's buttons", () => {
    const long = "/Users/x/Spaces/Mine. Длинное название. Прям вот легендарное";
    renderSelect({ value: long, options: [long, OTHER], onClose: vi.fn() });
    const name = screen.getByRole("button", { name: "Switch space: Mine. Длинное название. Прям вот легендарное" });
    const label = screen.getByText("Mine. Длинное название. Прям вот легендарное");
    const row = name.closest<HTMLElement>("[data-clipper-space-row]")!;

    // The name gives up width in the row and clips what does not fit.
    expect(name.parentElement).toBe(row);
    expect(name).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
    // The text is a flex item of a flex plate that shrinks too, so
    // `truncate` cuts it with an ellipsis; an inline text ignores it.
    expect(label).toHaveClass("min-w-0", "truncate");
    expect(label.parentElement).toHaveClass("inline-flex", "min-w-0", "max-w-full");
    expect(label.parentElement).not.toHaveClass("shrink-0");
    // The chevron follows the plate and never shrinks.
    const chevron = name.querySelector("svg");
    expect(label.parentElement?.nextElementSibling).toBe(chevron);
    expect(chevron).toHaveClass("lucide-chevron-right", "shrink-0");

    // The buttons follow the name in the row's flow, not over it.
    const more = within(row).getByRole("button", { name: "More" });
    const close = within(row).getByRole("button", { name: "Close" });
    const buttons = more.parentElement!;
    expect(name.nextElementSibling).toBe(buttons);
    expect(buttons).toContainElement(close);
    expect(buttons).toHaveClass("ml-auto", "flex");
    expect(buttons.className).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/);
    expect(more).toHaveClass("shrink-0");
  });

  it.each(["Enter", " ", "ArrowDown"])("opens from the keyboard with %j, as before", async (key) => {
    renderSelect();
    fireEvent.keyDown(trigger(), { key });
    expect(await screen.findByRole("menuitem", { name: "Journal" })).toBeInTheDocument();
  });

  // DESIGN_SYSTEM.md, «Ширина» (11.10.2026): a list under a search field has
  // the search width, the desktop space switcher's.
  it("gives the space list the search width", async () => {
    renderSelect();
    await openMenu();
    expect(screen.getByRole("textbox", { name: "Search spaces" }).closest("[data-floating-menu]"))
      .toHaveAttribute("data-floating-menu", "search");
  });

  it("pins Reveal in Finder and Add space below the space list, desktop-style", async () => {
    renderSelect();
    await openMenu();

    for (const name of ["Reveal in Finder", "Add space"]) {
      const action = screen.getByRole("menuitem", { name });
      const slot = action.querySelector("[data-card-menu-icon-slot]");
      // Leading icon in the shared slot, exactly like the desktop switcher.
      expect(action.firstElementChild).toBe(slot);
      expect(slot?.querySelector("svg")).not.toBeNull();
    }
    // Space rows keep the same slot empty so the menu holds one text column.
    const row = screen.getByRole("menuitem", { name: "Journal" });
    expect(row.querySelector("[data-card-menu-icon-slot]")).not.toBeNull();
    expect(row.querySelector("[data-card-menu-icon-slot] svg")).toBeNull();
  });

  it("reveals the current space and closes the menu", async () => {
    const props = renderSelect();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));

    // The action targets the space the clipper is aimed at, not a row.
    expect(props.onReveal).toHaveBeenCalledWith(CURRENT);
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Reveal in Finder" })).not.toBeInTheDocument();
    });
  });

  it("hands Add space to the host folder chooser", async () => {
    const props = renderSelect();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Add space" }));

    expect(props.onAddSpace).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("reaches the pinned actions with arrow navigation from search", async () => {
    renderSelect();
    await openMenu();
    const search = screen.getByRole("textbox", { name: "Search spaces" });

    // One destination space, then Reveal, then Add.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Add space" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );
  });

  // A chosen row blinks as a row of the app's menu of spaces does
  // (src/lib/menuBlink.ts; user's decision of 15.11.2026): its highlight out
  // for the first 75 ms and back for the next 75 ms, then the list closes and
  // the command runs, once, by a press and by Enter in the field alike.
  describe("the blink of a chosen row (user's decision of 15.11.2026)", () => {
    const THIRD = "/Users/x/Spaces/Zebra";
    const HALF = MOTION_MENU_BLINK_MS / 2;

    beforeEach(() => {
      setMenuBlinkMsForTests(MOTION_MENU_BLINK_MS);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Opens the list on real time, then holds the clock. */
    async function openBlinking(overrides: Partial<Parameters<typeof VaultSelect>[0]> = {}) {
      const props = renderSelect({ options: [CURRENT, OTHER, THIRD], ...overrides });
      await openMenu();
      vi.useFakeTimers();
      return { props, search: screen.getByRole("textbox", { name: "Search spaces" }) };
    }

    const row = (name: string) => screen.getByRole("menuitem", { name });
    const lit = (name: string) => row(name).getAttribute("data-search-menu-action-active") === "true";
    const listOpen = () => screen.queryByRole("textbox", { name: "Search spaces" }) !== null;
    const advance = (ms: number) => act(() => {
      vi.advanceTimersByTime(ms);
    });

    /** A press on the row, or Enter in the field on the row `steps` arrows down. */
    function choose(search: HTMLElement, name: string, how: "pointer" | "Enter", steps: number) {
      if (how === "pointer") {
        fireEvent.click(row(name));
        return;
      }
      for (let step = 0; step < steps; step++) fireEvent.keyDown(search, { key: "ArrowDown" });
      expect(lit(name)).toBe(true);
      fireEvent.keyDown(search, { key: "Enter" });
    }

    // Journal, then Zebra, then Reveal in Finder (3 steps), then Add space (4).
    for (const how of ["pointer", "Enter"] as const) {
      it(`blinks a space chosen by ${how}, then closes the list and switches once`, async () => {
        const { props, search } = await openBlinking();
        choose(search, "Journal", how, 1);
        expect(row("Journal")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(props.onChange).not.toHaveBeenCalled();
        // The pointer crossing another row does not take the highlight.
        fireEvent.pointerMove(row("Zebra"));
        advance(HALF);
        expect(row("Journal")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(lit("Journal")).toBe(true);
        expect(lit("Zebra")).toBe(false);
        expect(props.onChange).not.toHaveBeenCalled();
        expect(listOpen()).toBe(true);
        advance(HALF);
        expect(listOpen()).toBe(false);
        expect(props.onChange).toHaveBeenCalledTimes(1);
        expect(props.onChange).toHaveBeenCalledWith(OTHER);
      });

      it(`blinks Reveal in Finder chosen by ${how}, then reveals the current space once`, async () => {
        const { props, search } = await openBlinking();
        choose(search, "Reveal in Finder", how, 3);
        expect(row("Reveal in Finder")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        advance(HALF);
        expect(lit("Reveal in Finder")).toBe(true);
        expect(props.onReveal).not.toHaveBeenCalled();
        advance(HALF);
        expect(listOpen()).toBe(false);
        expect(props.onReveal).toHaveBeenCalledTimes(1);
        expect(props.onReveal).toHaveBeenCalledWith(CURRENT);
      });

      it(`blinks Add space chosen by ${how}, then hands it to the host once`, async () => {
        const { props, search } = await openBlinking();
        choose(search, "Add space", how, 4);
        expect(row("Add space")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        advance(HALF);
        expect(lit("Add space")).toBe(true);
        expect(props.onAddSpace).not.toHaveBeenCalled();
        advance(HALF);
        expect(listOpen()).toBe(false);
        expect(props.onAddSpace).toHaveBeenCalledTimes(1);
      });
    }

    it("switches once for a double click, a press on another row and Enter again during the blink", async () => {
      const { props, search } = await openBlinking();
      choose(search, "Journal", "pointer", 0);
      choose(search, "Journal", "pointer", 0);
      fireEvent.click(row("Zebra"));
      fireEvent.keyDown(search, { key: "Enter" });
      advance(HALF);
      fireEvent.keyDown(search, { key: "Enter" });
      advance(HALF);
      advance(MOTION_MENU_BLINK_MS);
      expect(props.onChange).toHaveBeenCalledTimes(1);
      expect(props.onChange).toHaveBeenCalledWith(OTHER);
    });

    it("keeps the query as it was chosen from during the blink", async () => {
      const { props, search } = await openBlinking();
      choose(search, "Journal", "Enter", 1);
      fireEvent.change(search, { target: { value: "Zeb" } });
      expect(search).toHaveValue("");
      advance(MOTION_MENU_BLINK_MS);
      expect(props.onChange).toHaveBeenCalledWith(OTHER);
    });

    it("runs nothing when Escape closes the list during the blink", async () => {
      const { props, search } = await openBlinking();
      choose(search, "Journal", "pointer", 0);
      fireEvent.keyDown(search, { key: "Escape" });
      expect(listOpen()).toBe(false);
      advance(MOTION_MENU_BLINK_MS * 2);
      expect(props.onChange).not.toHaveBeenCalled();
    });

    // Escape in the field: with a query typed the first one clears it and
    // keeps the list open with the caret in the field, the next one closes
    // it. Radix hears Escape on the document before the field does.
    it("clears a typed query on the first Escape and closes the list on the second", async () => {
      const { search } = await openBlinking();
      fireEvent.change(search, { target: { value: "Zeb" } });
      expect(screen.queryByRole("menuitem", { name: "Journal" })).toBeNull();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(listOpen()).toBe(true);
      expect(search).toHaveValue("");
      expect(row("Journal")).toBeInTheDocument();
      expect(search).toHaveFocus();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(listOpen()).toBe(false);
    });

    it("closes at once on Escape with no query", async () => {
      const { search } = await openBlinking();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(listOpen()).toBe(false);
    });

    it("closes and drops the command on Escape during the blink, a query typed", async () => {
      const { props, search } = await openBlinking();
      fireEvent.change(search, { target: { value: "Jou" } });
      choose(search, "Journal", "Enter", 1);
      fireEvent.keyDown(search, { key: "Escape" });
      expect(listOpen()).toBe(false);
      advance(MOTION_MENU_BLINK_MS * 2);
      expect(props.onChange).not.toHaveBeenCalled();
    });

    it("runs nothing when the list closes another way during the blink", async () => {
      const { props } = await openBlinking();
      choose(screen.getByRole("textbox", { name: "Search spaces" }), "Journal", "pointer", 0);
      // A press on the name closes the open list.
      pointerClick(trigger());
      expect(listOpen()).toBe(false);
      advance(MOTION_MENU_BLINK_MS * 2);
      expect(props.onChange).not.toHaveBeenCalled();
    });

    it("does not blink Reveal in Finder with no space chosen: it does nothing", async () => {
      renderSelect({ value: null, options: [OTHER] });
      fireEvent.keyDown(screen.getByRole("button", { name: /Switch space/ }), { key: "Enter" });
      await screen.findByRole("menuitem", { name: "Reveal in Finder" });
      vi.useFakeTimers();
      fireEvent.click(row("Reveal in Finder"));
      expect(row("Reveal in Finder")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    });
  });
});
