import { beforeEach, describe, expect, it } from "vitest";
import { tabbableIn, wrapTabFocus } from "./focusCycle";

function panel(html: string): HTMLElement {
  const container = document.createElement("div");
  container.tabIndex = -1;
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

describe("Tab stays inside the clipper panel (А6.9)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("visits enabled controls only, in document order", () => {
    const container = panel(`
      <button id="a">A</button>
      <button id="off" disabled>Off</button>
      <input id="b" />
      <fieldset disabled><button id="locked">Locked</button></fieldset>
      <div tabindex="-1" id="skip"></div>
      <div tabindex="0" id="c"></div>
    `);
    expect(tabbableIn(container).map((element) => element.id)).toEqual(["a", "b", "c"]);
  });

  it("wraps past the last element and before the first", () => {
    const container = panel(`<button id="a">A</button><button id="b">B</button><button id="c">C</button>`);
    const [a, b, c] = ["a", "b", "c"].map((id) => document.getElementById(id)!);

    expect(wrapTabFocus(container, c!, false)).toBe(a);
    expect(wrapTabFocus(container, a!, true)).toBe(c);
    // In the middle the browser's own step already stays inside.
    expect(wrapTabFocus(container, b!, false)).toBeNull();
    expect(wrapTabFocus(container, b!, true)).toBeNull();
  });

  it("enters at the edge when the panel itself holds focus", () => {
    const container = panel(`<button id="a">A</button><button id="b">B</button>`);
    expect(wrapTabFocus(container, container, false)).toBe(document.getElementById("a"));
    expect(wrapTabFocus(container, container, true)).toBe(document.getElementById("b"));
  });
});
