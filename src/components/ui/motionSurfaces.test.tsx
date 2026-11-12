import { readFileSync } from "node:fs";
import path from "node:path";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installMotionInput, MOTION_KEY_ATTRIBUTE } from "@/lib/motionInput";
import { setMotionLevel } from "@/test/motionLevel";

import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "./alert-dialog";
import { Button } from "./button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./context-menu";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { MODAL_OVERLAY_CLASS, MODAL_SURFACE_CLASS } from "./modal-window";

// Menus, tooltips and windows by the level (SPEC_MOTION_LEVELS.md, М1, М2,
// М3, М5; «Тесты», п. 11). jsdom runs no stylesheet: the cases check what the
// rules of global.css read, the surfaces' slots, states and the key's mark,
// and the rules themselves.

const css = readFileSync(path.join(process.cwd(), "src/styles/global.css"), "utf8");

/** The surfaces whose motion tw-animate-css sets on themselves. */
const SURFACE_SLOTS = [
  "dropdown-menu-content",
  "dropdown-menu-sub-content",
  "context-menu-content",
  "context-menu-sub-content",
  "tooltip-content",
  "dialog-overlay",
  "dialog-content",
  "alert-dialog-overlay",
  "alert-dialog-content",
] as const;

/** How the rule of a key's motion ends: its last selector, the pseudo-element
 *  after everything a key's surface holds but a menu or a tooltip the pointer
 *  opened inside it. */
const KEY_RULE_END = ':not([data-motion-key]) *\n)::after';

/** The body of the top-level rule whose selector ends with `selectorEnd`. */
function topLevelRule(selectorEnd: string): { selector: string; body: string; depth: number } | null {
  const at = css.indexOf(`${selectorEnd} {`);
  if (at < 0) return null;
  const before = css.slice(0, at);
  const start = before.lastIndexOf("}") + 1;
  const depth = [...before].reduce((open, char) => open + (char === "{" ? 1 : char === "}" ? -1 : 0), 0);
  const bodyStart = at + selectorEnd.length + 2;
  return {
    selector: css.slice(start, at + selectorEnd.length).replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    body: css.slice(bodyStart, css.indexOf("}", bodyStart)),
    depth,
  };
}

let removeInput: () => void;
beforeEach(() => {
  removeInput = installMotionInput();
});
afterEach(() => removeInput());

function Menu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Action</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Nested</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menuSurface = () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');

describe("a menu (М1)", () => {
  it("opened by the pointer moves by the level: no key's mark", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(screen.getByText("Open menu"));
    expect(menuSurface()).not.toBeNull();
    expect(menuSurface()).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("opened by a key carries the key's mark, and lands at once at every level", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    screen.getByText("Open menu").focus();
    await user.keyboard("{Enter}");
    expect(menuSurface()).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("marks a submenu the arrow opened inside a menu the pointer opened", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(screen.getByText("Open menu"));
    const more = screen.getByText("More");
    act(() => more.focus());
    await user.keyboard("{ArrowRight}");
    const sub = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]');
      expect(node).not.toBeNull();
      return node;
    });
    expect(sub).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    expect(menuSurface()).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });
});

describe("a context menu (М2)", () => {
  function Context() {
    return (
      <ContextMenu>
        <ContextMenuTrigger>Card</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
  const surface = () => document.querySelector<HTMLElement>('[data-slot="context-menu-content"]');

  it("opened by a right click carries no key's mark", () => {
    render(<Context />);
    const card = screen.getByText("Card");
    fireEvent.pointerDown(card, { button: 2 });
    fireEvent.contextMenu(card);
    expect(surface()).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("opened by the keyboard's context menu key carries it", () => {
    render(<Context />);
    const card = screen.getByText("Card");
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    fireEvent.contextMenu(card);
    expect(surface()).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });
});

describe("a tooltip (М3)", () => {
  const tip = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');

  it("under the pointer carries no key's mark, after a key too", async () => {
    render(<Button size="icon-xs" aria-label="Connect">+</Button>);
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.pointerMove(screen.getByRole("button", { name: "Connect" }), { movementX: 2 });
    await screen.findByRole("tooltip");
    expect(tip()).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("on the keyboard's focus carries it: it stands at once at every level", async () => {
    render(<Button size="icon-xs" aria-label="Connect">+</Button>);
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Connect" }).focus());
    await screen.findByRole("tooltip");
    expect(tip()).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });
});

describe("a window and its scrim (М5)", () => {
  function Windows({ alert = false }: { alert?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "N" && event.metaKey) setOpen(true);
          }}
        >
          New collection
        </button>
        {alert ? (
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent aria-describedby={undefined}>
              <AlertDialogTitle>Delete</AlertDialogTitle>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>New collection</DialogTitle>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }

  for (const alert of [false, true]) {
    const prefix = alert ? "alert-dialog" : "dialog";
    const parts = () => ({
      surface: document.querySelector<HTMLElement>(`[data-slot="${prefix}-content"]`),
      scrim: document.querySelector<HTMLElement>(`[data-slot="${prefix}-overlay"]`),
    });

    it(`${prefix}: opened by a button carries no key's mark`, async () => {
      const user = userEvent.setup();
      render(<Windows alert={alert} />);
      await user.click(screen.getByText("New collection"));
      const { surface, scrim } = parts();
      expect(surface).not.toBeNull();
      expect(surface).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
      expect(scrim).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    });

    it(`${prefix}: opened by a key carries it on the surface and the scrim`, () => {
      render(<Windows alert={alert} />);
      fireEvent.keyDown(screen.getByText("New collection"), { key: "N", metaKey: true, shiftKey: true });
      const { surface, scrim } = parts();
      expect(surface).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
      expect(scrim).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    });
  }

  it("keeps Full's classes: the window 200 ms, the scrim tw-animate-css's 150 ms, a fade and 95 %", () => {
    expect(MODAL_SURFACE_CLASS).toContain("duration-200");
    expect(MODAL_SURFACE_CLASS).toContain("data-[state=open]:zoom-in-95");
    expect(MODAL_SURFACE_CLASS).toContain("data-[state=closed]:zoom-out-95");
    expect(MODAL_OVERLAY_CLASS).not.toMatch(/duration-/);
    expect(MODAL_OVERLAY_CLASS).toContain("data-[state=open]:fade-in-0");
  });
});

describe("the surfaces' rules in global.css", () => {
  it("at Minimal time every surface 150 ms in and 100 ms out on E, outside any layer", () => {
    const enter = topLevelRule(`[data-slot="alert-dialog-content"]\n)`);
    expect(enter).not.toBeNull();
    expect(enter?.depth).toBe(0);
    expect(enter?.selector.startsWith('[data-motion="minimal"] :is(')).toBe(true);
    for (const slot of SURFACE_SLOTS) expect(enter?.selector).toContain(`[data-slot="${slot}"]`);
    expect(enter?.body).toMatch(/animation-duration: var\(--motion-enter\);/);
    expect(enter?.body).toMatch(/animation-timing-function: var\(--motion-ease\);/);

    const leave = topLevelRule(`[data-slot="alert-dialog-content"]\n)[data-state="closed"]`);
    expect(leave?.depth).toBe(0);
    for (const slot of SURFACE_SLOTS) expect(leave?.selector).toContain(`[data-slot="${slot}"]`);
    expect(leave?.body).toMatch(/animation-duration: var\(--motion-exit\);/);
  });

  it("lands a key's surface at once at every level, its scrim and what it holds", () => {
    const atOnce = topLevelRule(KEY_RULE_END);
    expect(atOnce?.depth).toBe(0);
    expect(atOnce?.selector).toMatch(/^\[data-motion-key\],$/m);
    expect(atOnce?.body).toMatch(/animation-duration: 0\.01ms !important;/);
    expect(atOnce?.body).toMatch(/transition-duration: 0\.01ms !important;/);
  });

  it("stands a tooltip after the first at once at Minimal (М3), and the search (М6)", () => {
    const atOnce = topLevelRule(KEY_RULE_END);
    expect(atOnce?.selector).toContain('[data-motion="minimal"] [data-slot="tooltip-content"][data-state="instant-open"],');
    expect(atOnce?.selector).toContain('[data-motion="minimal"] :is([data-search-overlay], [data-search-overlay-scrim]),');
  });

  it("keeps Off's at once for every surface", () => {
    const atOnce = topLevelRule(KEY_RULE_END);
    expect(atOnce?.selector).toContain('[data-motion="off"] *:not(.mine-progress-indeterminate):not(.animate-spin),');
  });

  it("names the surfaces by the slots the rules read", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(screen.getByText("Open menu"));
    expect(menuSurface()).toHaveAttribute("data-state", "open");
    expect(menuSurface()?.className).toContain("data-[state=open]:animate-in");
  });

  it("does not change a surface's classes by the level: the stylesheet times it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Menu />);
    await user.click(screen.getByText("Open menu"));
    const full = menuSurface()?.className;
    unmount();
    setMotionLevel("minimal");
    render(<Menu />);
    await user.click(screen.getByText("Open menu"));
    expect(menuSurface()?.className).toBe(full);
  });
});
