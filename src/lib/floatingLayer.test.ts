import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MENU_PLATE_GAP_PX, menuPlateOf, menuPlateOffsets } from "./floatingLayer";

const css = readFileSync(path.join(process.cwd(), "src/styles/global.css"), "utf8");

// DESIGN_SYSTEM.md, «Всплывающие элементы», «Отступ от кнопки» (11.10.2026).
describe("a menu's place off its button's plate", () => {
  it("keeps the surface inset, not a number of its own", () => {
    expect(css).toMatch(/--spacing-surface: var\(--spacing-s1\);/);
    expect(css).toMatch(new RegExp(`--spacing-s1: ${MENU_PLATE_GAP_PX}px;`));
  });

  // A 40px chrome row: the box is the row, the 24px plate stands centred.
  const box = { top: 0, right: 124, bottom: 40, left: 100 };
  const plate = { top: 8, right: 124, bottom: 32, left: 100 };

  it("counts the gap from the plate under a row-tall box", () => {
    expect(menuPlateOffsets(box, plate, "bottom", "end")).toEqual({ sideOffset: -4, alignOffset: 0 });
    expect(menuPlateOffsets(box, plate, "top", "start")).toEqual({ sideOffset: -4, alignOffset: 0 });
  });

  it("lines the menu up with the plate's edge when the plate stands in from the box's", () => {
    const pill = { top: 7.5, right: 88, bottom: 31.5, left: 8 };
    const trigger = { top: 0, right: 96, bottom: 39, left: 0 };
    expect(menuPlateOffsets(trigger, pill, "bottom", "start")).toEqual({ sideOffset: -3.5, alignOffset: 8 });
    expect(menuPlateOffsets(trigger, pill, "bottom", "end")).toEqual({ sideOffset: -3.5, alignOffset: 8 });
  });

  it("keeps the plain gap for a button that is its own plate", () => {
    expect(menuPlateOffsets(plate, plate, "bottom", "start")).toEqual({ sideOffset: MENU_PLATE_GAP_PX, alignOffset: 0 });
    expect(menuPlateOffsets(plate, plate, "right", "end")).toEqual({ sideOffset: MENU_PLATE_GAP_PX, alignOffset: 0 });
  });

  it("measures from the chrome plate inside a trigger, else from the trigger", () => {
    const chrome = document.createElement("button");
    const chromePlate = document.createElement("span");
    chromePlate.setAttribute("data-chrome-plate", "");
    chrome.append(chromePlate);
    expect(menuPlateOf(chrome)).toBe(chromePlate);

    const plain = document.createElement("button");
    plain.append(document.createElement("span"));
    expect(menuPlateOf(plain)).toBe(plain);
  });
});
