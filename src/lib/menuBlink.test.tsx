// The blink of a chosen menu item (user's decision of 13.11.2026;
// SPEC_MOTION_LEVELS.md, «Вне ролей»; DESIGN_SYSTEM.md, «Нажатие»): the
// highlight out for half of 150 ms and back for the other half, then the menu
// closes and the command runs, once, on every level, by the pointer, Enter
// and Space alike. A check, a choice of a value, a submenu's trigger, an item
// that keeps its menu open and a disabled item do not blink.
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { setMotionLevel } from "@/test/motionLevel";
import { MOTION_LEVELS, MOTION_MENU_BLINK_MS } from "./motion";
import { MENU_BLINK_ATTRIBUTE, menuBlinkMs, setMenuBlinkMsForTests, useMenuRowBlink } from "./menuBlink";

const HALF = MOTION_MENU_BLINK_MS / 2;

beforeEach(() => {
  setMenuBlinkMsForTests(MOTION_MENU_BLINK_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

function Menu({ onAction, onKeep, onCheck, onChoose }: {
  onAction: () => void;
  onKeep?: () => void;
  onCheck?: () => void;
  onChoose?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onAction}>Action</DropdownMenuItem>
        <DropdownMenuItem
          staysOpen
          onSelect={(event) => {
            event.preventDefault();
            onKeep?.();
          }}
        >
          Keep
        </DropdownMenuItem>
        <DropdownMenuItem disabled onSelect={onAction}>Unavailable</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={false} onCheckedChange={onCheck} onSelect={(event) => event.preventDefault()}>
          Check
        </DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value="a" onValueChange={onChoose}>
          <DropdownMenuRadioItem value="b" onSelect={(event) => event.preventDefault()}>Choice</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={onAction}>Nested</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menu = () => document.querySelector('[data-slot="dropdown-menu-content"]');
const item = (name: string) => screen.getByRole("menuitem", { name });

/** Opens the menu on real time, then holds the clock: the blink is timed
 *  from here on by the test. */
async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByText("Open menu"));
  expect(menu()).not.toBeNull();
  vi.useFakeTimers();
}

/** A choice as the menu hears it: the pointer's click, or Enter or Space on
 *  the focused item, which the menu turns into a click. */
function choose(name: string, how: "pointer" | "Enter" | "Space", role = "menuitem") {
  const target = screen.getByRole(role, { name });
  act(() => {
    if (how === "pointer") {
      fireEvent.click(target);
      return;
    }
    target.focus();
    fireEvent.keyDown(target, { key: how === "Enter" ? "Enter" : " " });
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the blink of a chosen menu item", () => {
  it("is 150 ms long, the new value of the design system", () => {
    expect(MOTION_MENU_BLINK_MS).toBe(150);
    expect(menuBlinkMs()).toBe(MOTION_MENU_BLINK_MS);
  });

  for (const level of MOTION_LEVELS) {
    for (const how of ["pointer", "Enter", "Space"] as const) {
      it(`${level}: chosen by ${how}, it blinks, then the menu closes and the command runs once`, async () => {
        setMotionLevel(level);
        const onAction = vi.fn();
        render(<Menu onAction={onAction} />);
        await openMenu();
        choose("Action", how);
        // The highlight is out for the first half, the menu still open.
        expect(item("Action")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(onAction).not.toHaveBeenCalled();
        advance(HALF);
        // Back for the second half.
        expect(item("Action")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(onAction).not.toHaveBeenCalled();
        expect(menu()).not.toBeNull();
        advance(HALF);
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(menu()).toBeNull();
      });
    }
  }

  it("runs the command once for a double click and for Enter pressed again during the blink", async () => {
    const onAction = vi.fn();
    render(<Menu onAction={onAction} />);
    await openMenu();
    choose("Action", "pointer");
    choose("Action", "pointer");
    choose("Action", "Enter");
    advance(HALF);
    choose("Action", "Space");
    advance(HALF);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    advance(MOTION_MENU_BLINK_MS);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("runs nothing when the menu closes during the blink", async () => {
    const onAction = vi.fn();
    render(<Menu onAction={onAction} />);
    await openMenu();
    choose("Action", "pointer");
    act(() => {
      fireEvent.keyDown(item("Action"), { key: "Escape" });
    });
    expect(menu()).toBeNull();
    advance(MOTION_MENU_BLINK_MS);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not blink an item that keeps its menu open, a check or a choice of a value", async () => {
    const onKeep = vi.fn();
    const onCheck = vi.fn();
    const onChoose = vi.fn();
    render(<Menu onAction={vi.fn()} onKeep={onKeep} onCheck={onCheck} onChoose={onChoose} />);
    await openMenu();
    choose("Keep", "pointer");
    expect(item("Keep")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onKeep).toHaveBeenCalledTimes(1);
    choose("Check", "Enter", "menuitemcheckbox");
    expect(screen.getByRole("menuitemcheckbox", { name: "Check" })).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onCheck).toHaveBeenCalledTimes(1);
    choose("Choice", "pointer", "menuitemradio");
    expect(screen.getByRole("menuitemradio", { name: "Choice" })).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
  });

  it("does not blink a disabled item or a submenu's trigger", async () => {
    const onAction = vi.fn();
    render(<Menu onAction={onAction} />);
    await openMenu();
    choose("Unavailable", "pointer");
    expect(item("Unavailable")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    choose("More", "Enter");
    expect(item("More")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    advance(MOTION_MENU_BLINK_MS);
    expect(onAction).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });
});

// A row of a menu with a search field, which the menu chooses itself by a
// press or by Enter in the field, blinks the same way (user's decision of
// 15.11.2026; the space menu, VaultSwitcher.test.tsx).
function RowMenu({ onRun }: { onRun: (key: string) => void }) {
  const blink = useMenuRowBlink<string>();
  return (
    <div>
      {["One", "Two"].map((key) => (
        <SearchMenuAction
          key={key}
          active={blink.chosen === key}
          blinkOff={blink.off && blink.chosen === key}
          onPress={() => blink.choose(key, () => onRun(key))}
        >
          {key}
        </SearchMenuAction>
      ))}
      <button type="button" onClick={blink.cancel}>Close</button>
    </div>
  );
}

describe("the blink of a row a menu chooses itself", () => {
  const row = (name: string) => screen.getByRole("menuitem", { name });

  for (const level of MOTION_LEVELS) {
    it(`${level}: holds the chosen row for the whole blink, out then back, and runs once`, () => {
      setMotionLevel(level);
      const onRun = vi.fn();
      render(<RowMenu onRun={onRun} />);
      vi.useFakeTimers();
      fireEvent.click(row("One"));
      expect(row("One")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
      expect(row("One")).toHaveAttribute("data-search-menu-action-active", "true");
      advance(HALF);
      expect(row("One")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
      expect(row("One")).toHaveAttribute("data-search-menu-action-active", "true");
      expect(onRun).not.toHaveBeenCalled();
      advance(HALF);
      expect(onRun).toHaveBeenCalledTimes(1);
      expect(onRun).toHaveBeenCalledWith("One");
      expect(row("One")).not.toHaveAttribute("data-search-menu-action-active");
    });
  }

  it("chooses nothing a second time during the blink, the same row or another", () => {
    const onRun = vi.fn();
    render(<RowMenu onRun={onRun} />);
    vi.useFakeTimers();
    fireEvent.click(row("One"));
    fireEvent.click(row("One"));
    fireEvent.click(row("Two"));
    expect(row("Two")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    advance(MOTION_MENU_BLINK_MS * 2);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith("One");
  });

  it("drops the command when the menu closes during the blink", () => {
    const onRun = vi.fn();
    render(<RowMenu onRun={onRun} />);
    vi.useFakeTimers();
    fireEvent.click(row("One"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(row("One")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    advance(MOTION_MENU_BLINK_MS * 2);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("drops the command when the menu goes away during the blink", () => {
    const onRun = vi.fn();
    const { unmount } = render(<RowMenu onRun={onRun} />);
    vi.useFakeTimers();
    fireEvent.click(row("One"));
    unmount();
    advance(MOTION_MENU_BLINK_MS * 2);
    expect(onRun).not.toHaveBeenCalled();
  });
});

// The highlight is a utility of Tailwind's layer: the pointer's
// (`hover:state-active`), the keyboard's (`focus:state-active`) and the
// active row's (`state-active`). An unlayered rule wins over every layered
// one whatever its selector, so the blink puts out each of them.
it("puts the highlight out from an unlayered rule", () => {
  const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\[data-menu-blink\]\s*\{\s*background-image:\s*none;\s*\}/.exec(css);
  expect(rule).not.toBeNull();
  const before = css.slice(0, rule?.index ?? 0);
  const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
  expect(depth).toBe(0);
  expect(MENU_BLINK_ATTRIBUTE).toBe("data-menu-blink");
});
