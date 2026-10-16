import { afterEach, describe, expect, it } from "vitest";
import { topRowCut } from "./topRowFit";

/** Give an element the box a layout would give it. */
function place(element: Element, left: number, right: number): void {
  element.getBoundingClientRect = () => new DOMRect(left, 0, right - left, 30);
}

function truncated(element: Element): void {
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: 900 });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 60 });
}

/** The row and its half over the feed, as the app lays them: the
 *  selection's layer with its count and commands, the view's layer and an
 *  open card's layer with its name and actions. */
function row({ selection, detail }: { selection: boolean; detail: boolean }) {
  document.body.innerHTML = `
    <div data-row>
      <button data-place>Everything</button>
      <div data-top-row-bar>
        <div data-entered="${selection}" data-top-row-wraps>
          <div data-commands data-top-row-part="whole"><div data-count>3 selected</div></div>
        </div>
        <div data-entered="${!selection && !detail}"><div data-view></div></div>
        <div data-entered="${detail}"><div data-name>a very long card name</div><div data-card-actions></div></div>
      </div>
    </div>`;
  const element = (selector: string) => document.querySelector(selector)!;
  place(element("[data-row]"), 0, 800);
  place(element("[data-top-row-bar]"), 200, 800);
  return {
    row: element("[data-row]"),
    count: element("[data-count]"),
    commands: element("[data-commands]"),
    name: element("[data-name]"),
    cardActions: element("[data-card-actions]"),
    view: element("[data-view]"),
  };
}

describe("topRowCut: only the selection's commands take a second row (SPEC_NARROW_WINDOW.md, У10)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("holds the selection while its commands stand inside the half", () => {
    const { row: element, commands } = row({ selection: true, detail: false });
    place(commands, 200, 800);
    expect(topRowCut(element)).toBe(false);
  });

  it("does not wrap for a truncated count alone", () => {
    const { row: element, count, commands } = row({ selection: true, detail: false });
    truncated(count);
    place(commands, 200, 800);
    expect(topRowCut(element)).toBe(false);
  });

  it("wraps when the commands stand past either edge of the half, not by a rounding", () => {
    const { row: element, commands } = row({ selection: true, detail: false });
    place(commands, 200, 800.4);
    expect(topRowCut(element)).toBe(false);
    place(commands, 200, 801);
    expect(topRowCut(element)).toBe(true);
    place(commands, 190, 790);
    expect(topRowCut(element)).toBe(true);
  });

  it("never wraps an open card, its long name or its actions, however narrow the row", () => {
    const { row: element, commands, name, cardActions } = row({ selection: false, detail: true });
    truncated(name);
    place(cardActions, 0, 2000);
    place(commands, 0, 2000);
    expect(topRowCut(element)).toBe(false);
  });

  it("never wraps the view's controls", () => {
    const { row: element, commands, view } = row({ selection: false, detail: false });
    place(view, 0, 2000);
    place(commands, 0, 2000);
    expect(topRowCut(element)).toBe(false);
  });

  it("does not wrap a selection while an open card shares the half", () => {
    const { row: element, commands } = row({ selection: true, detail: true });
    place(commands, 0, 2000);
    expect(topRowCut(element)).toBe(false);
  });
});
