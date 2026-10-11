import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

describe("DropdownMenu", () => {
  it("does not open trigger menus from modified arrow shortcuts", () => {
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.keyDown(screen.getByText("Open menu"), {
      key: "ArrowDown",
      metaKey: true,
    });

    expect(screen.queryByText("Action item")).not.toBeInTheDocument();
  });

  it("uses active surface for item focus and open submenu state", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.getByText("Action item")).toHaveClass("focus:state-active");
    expect(screen.getByText("Action item")).not.toHaveClass("focus:bg-accent");
    expect(screen.getByText("Nested actions")).toHaveClass(
      "focus:state-active",
      "data-[state=open]:state-active",
    );
    expect(screen.getByText("Nested actions")).not.toHaveClass(
      "data-[state=open]:bg-accent",
    );
  });

  // DESIGN_SYSTEM.md, «Цвет текста и значков»: focus and an open submenu
  // lift the icon one step together with the text.
  it("lifts the item icon with its text on focus and an open submenu", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete item</DropdownMenuItem>
          <DropdownMenuItem disabled>Unavailable item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const iconAtRest = "[&_svg:not([class*='text-'])]:text-muted-foreground";
    const iconOnFocus = "focus:[&_svg:not([class*='text-'])]:text-foreground";
    const iconOnOpen = "data-[state=open]:[&_svg:not([class*='text-'])]:text-foreground";

    expect(screen.getByText("Action item")).toHaveClass("focus:text-foreground", iconAtRest, iconOnFocus);
    expect(screen.getByText("Nested actions")).toHaveClass(
      "focus:text-foreground",
      "data-[state=open]:text-foreground",
      iconAtRest,
      iconOnFocus,
      iconOnOpen,
    );
    // Destructive keeps its colour on text and icon in every state.
    expect(screen.getByText("Delete item")).toHaveClass(
      "data-[variant=destructive]:focus:text-destructive",
      "data-[variant=destructive]:[&_svg]:!text-destructive",
    );
    // Disabled keeps the tertiary step.
    expect(screen.getByText("Unavailable item")).toHaveClass(
      "data-[disabled]:text-tertiary-foreground",
      "data-[disabled]:[&_svg:not([class*='text-'])]:text-tertiary-foreground",
    );
  });

  it("uses the feed card surface for floating menu content", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = document.querySelector("[data-slot='dropdown-menu-content']");
    const subContent = document.querySelector("[data-slot='dropdown-menu-sub-content']");

    expect(content).toHaveClass("bg-card", "text-card-foreground");
    expect(content).not.toHaveClass("bg-popover", "text-popover-foreground");
    expect(subContent).toHaveClass("bg-card", "text-card-foreground");
    expect(subContent).not.toHaveClass("bg-popover", "text-popover-foreground");
  });

  // DESIGN_SYSTEM.md, «Ширина» (11.10.2026): the width is the role's.
  it("gives the menu and its submenu the action width unless they are told search", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    for (const slot of ["dropdown-menu-content", "dropdown-menu-sub-content"]) {
      const content = document.querySelector(`[data-slot='${slot}']`);
      expect(content).toHaveAttribute("data-floating-menu", "action");
      expect(content).not.toHaveAttribute("data-floating-menu-width");
      expect(content?.className).not.toMatch(/(?:^|\s)(?:min-|max-)?w-/);
    }
  });

  it("gives a list under a search field the search width, on the menu and on a submenu", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent widthRole="search">
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent widthRole="search">
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    for (const slot of ["dropdown-menu-content", "dropdown-menu-sub-content"]) {
      const content = document.querySelector(`[data-slot='${slot}']`);
      expect(content).toHaveAttribute("data-floating-menu", "search");
    }
  });

  it("does not take its width from its rows: a long row and a short one give one menu", () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(176);
    try {
      const menus = ["Go", "A row far longer than any menu of actions is ever wide"].map((row) => {
        const { unmount } = render(
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>{row}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>,
        );
        const content = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-content']");
        const shape = {
          role: content?.getAttribute("data-floating-menu"),
          width: content?.style.width,
          minWidth: content?.style.minWidth,
          maxWidth: content?.style.maxWidth,
        };
        unmount();
        return shape;
      });
      expect(menus[0]).toEqual({ role: "action", width: "", minWidth: "", maxWidth: "" });
      expect(menus[1]).toEqual(menus[0]);
    } finally {
      width.mockRestore();
    }
  });
});

// DESIGN_SYSTEM.md, «Всплывающие элементы», «Отступ от кнопки» (11.10.2026):
// a menu opens 4px off the plate one sees and flush with its edge, wherever
// the plate stands inside the trigger's box.
describe("DropdownMenu off its button's plate", () => {
  type Rect = { top: number; right: number; bottom: number; left: number };

  // jsdom lays nothing out: floating-ui reads a 0×0 viewport and flips every
  // menu. Give the page a window's size for these placements.
  const viewport = { clientWidth: 1024, clientHeight: 768 };
  beforeEach(() => {
    for (const [key, value] of Object.entries(viewport)) {
      Object.defineProperty(document.documentElement, key, { configurable: true, value });
    }
  });
  afterEach(() => {
    for (const key of Object.keys(viewport)) {
      Reflect.deleteProperty(document.documentElement, key);
    }
  });

  function placeBoxes(boxes: (element: HTMLElement) => Rect | null) {
    const original = HTMLElement.prototype.getBoundingClientRect;
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const box = boxes(this);
      if (!box) return original.call(this);
      const { top, right, bottom, left } = box;
      return { top, right, bottom, left, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect;
    });
  }

  // Where Radix put the menu: the popper wrapper's translate.
  function menuPosition(): { x: number; y: number } {
    const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
    const match = wrapper?.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
    if (!match) throw new Error(`menu is not placed: ${wrapper?.style.transform}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  it("opens 4px under a chrome button's plate, not under its row-tall box, flush with the plate's right edge", async () => {
    // A 40px chrome row: the button's box fills it, its 24px plate is centred.
    const rect = placeBoxes((element) => {
      if (element.hasAttribute("data-chrome-plate")) return { top: 8, right: 124, bottom: 32, left: 100 };
      if (element.getAttribute("data-slot") === "dropdown-menu-trigger") return { top: 0, right: 124, bottom: 40, left: 100 };
      return null;
    });
    try {
      render(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="chrome" size="chrome-icon" aria-label="Display options" tooltip={false}>
              <span>icon</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      fireEvent.pointerDown(screen.getByRole("button", { name: "Display options" }), { button: 0, ctrlKey: false });
      // The menu has no size in jsdom: its right edge is its x.
      await waitFor(() => expect(menuPosition()).toEqual({ x: 124, y: 36 }));
    } finally {
      rect.mockRestore();
    }
  });

  it("opens 4px under a button that is its own plate, flush with its left edge", async () => {
    const rect = placeBoxes((element) => (
      element.getAttribute("data-slot") === "dropdown-menu-trigger" ? { top: 10, right: 90, bottom: 42, left: 30 } : null
    ));
    try {
      render(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Connect</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      fireEvent.pointerDown(screen.getByRole("button", { name: "Connect" }), { button: 0, ctrlKey: false });
      await waitFor(() => expect(menuPosition()).toEqual({ x: 30, y: 46 }));
    } finally {
      rect.mockRestore();
    }
  });

  it("opens 4px over a plate inside a taller box when it opens upward", async () => {
    const rect = placeBoxes((element) => {
      if (element.hasAttribute("data-chrome-plate")) return { top: 508, right: 224, bottom: 532, left: 200 };
      if (element.getAttribute("data-slot") === "dropdown-menu-trigger") return { top: 500, right: 224, bottom: 540, left: 200 };
      return null;
    });
    try {
      render(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="chrome" size="chrome-icon" aria-label="More" tooltip={false}>
              <span>icon</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0, ctrlKey: false });
      // No height in jsdom: the menu's bottom edge is its y.
      await waitFor(() => expect(menuPosition()).toEqual({ x: 200, y: 504 }));
    } finally {
      rect.mockRestore();
    }
  });
});

// DESIGN_SYSTEM.md, «Открытое меню»: the pointer's hover passes under an open
// menu; a press outside only closes it (src/lib/openMenus.ts).
describe("DropdownMenu over the page", () => {
  function renderMenuOverPage(under: { onPointerEnter?: () => void; onPointerDown?: () => void; onClick?: () => void } = {}) {
    render(
      <>
        <button type="button" {...under}>Under the menu</button>
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    return { trigger: screen.getByText("Open menu"), under: screen.getByText("Under the menu") };
  }

  it("lets the hover reach what lies under the open menu", async () => {
    const user = userEvent.setup();
    const onPointerEnter = vi.fn();
    const { trigger, under } = renderMenuOverPage({ onPointerEnter });

    await user.click(trigger);
    expect(screen.getByText("Action item")).toBeInTheDocument();
    // A modal menu set `pointer-events: none` here; user-event refuses to
    // hover through it.
    expect(document.body.style.pointerEvents).toBe("");
    await user.hover(under);

    expect(onPointerEnter).toHaveBeenCalled();
    expect(screen.getByText("Action item")).toBeInTheDocument();
  });

  it("closes on a press outside, and neither the press nor its click acts there", async () => {
    const user = userEvent.setup();
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    const { trigger, under } = renderMenuOverPage({ onPointerDown, onClick });

    await user.click(trigger);
    await user.click(under);

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    // As the modal menu did, the focus goes back to the trigger.
    await waitFor(() => expect(trigger).toHaveFocus());

    // With the menu closed the next click is the page's again.
    await user.click(under);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("holds the rest of the press that opened it", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      // A trigger inside a clickable row: opening the menu does not open the row.
      <div role="presentation" onClick={onRowClick}>
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>,
    );

    await user.click(screen.getByText("Open menu"));

    expect(screen.getByText("Action item")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("closes on Escape and gives the focus back to its trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = renderMenuOverPage();

    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("scrolls nothing under it with the wheel", async () => {
    const user = userEvent.setup();
    const { trigger, under } = renderMenuOverPage();

    await user.click(trigger);

    expect(fireEvent.wheel(under, { deltaY: 40 })).toBe(false);
    expect(fireEvent.wheel(screen.getByText("Action item"), { deltaY: 40 })).toBe(true);
  });

  it("closes only itself when it is open over a dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog text</DialogDescription>
          <DropdownMenu>
            <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Action item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByText("Open menu"));
    await user.click(screen.getByText("Dialog text"));

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    expect(screen.getByText("Dialog title")).toBeInTheDocument();
  });
});
