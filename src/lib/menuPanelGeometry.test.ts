import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_MENU_OFFSET_PX,
  MENU_ACTION_WIDTH_PX,
  MENU_PANEL_SIZE,
  MENU_PANEL_SUBMENU_MAX_HEIGHT_PX,
  MENU_SEARCH_WIDTH_PX,
  MENU_SHADOW_FIELD_PX,
  SUBMENU_TRIGGER_INSET_PX,
  fitsPanel,
  layoutPanel,
  panelAnchor,
  panelOrigin,
  placeMenu,
  submenuSide,
  type ScreenRect,
} from "./menuPanelGeometry";
import { FLOATING_LAYER_EDGE_PX, MENU_PLATE_GAP_PX } from "./floatingLayer";

// A 1440 × 900 screen whose visible frame starts under a 25 pt menu bar.
const SCREEN: ScreenRect = { x: 0, y: 25, width: 1440, height: 875 };
const MENU = { width: MENU_ACTION_WIDTH_PX, height: 300 };
const PAD = FLOATING_LAYER_EDGE_PX;
const FIELD = MENU_SHADOW_FIELD_PX;

function plate(x: number, y: number): ScreenRect {
  return { x, y, width: 24, height: 24 };
}

describe("placeMenu from a button's plate", () => {
  it("stands below the plate, flush with its right edge, the plate gap off it", () => {
    const placement = placeMenu({ kind: "plate", plate: plate(700, 200), align: "end" }, MENU, SCREEN);
    expect(placement.side).toBe("bottom");
    expect(placement.menu).toEqual({ x: 724 - 240, y: 224 + MENU_PLATE_GAP_PX, width: 240, height: 300 });
    expect(placement.maxHeight).toBeNull();
  });

  it("flips above the plate when the screen's bottom has no room", () => {
    const placement = placeMenu({ kind: "plate", plate: plate(700, 700), align: "end" }, MENU, SCREEN);
    expect(placement.side).toBe("top");
    expect(placement.menu.y + placement.menu.height).toBe(700 - MENU_PLATE_GAP_PX);
  });

  it("keeps below when it just fits, the padding off the bottom", () => {
    const y = SCREEN.y + SCREEN.height - PAD - 300 - MENU_PLATE_GAP_PX - 24;
    expect(placeMenu({ kind: "plate", plate: plate(700, y), align: "end" }, MENU, SCREEN).side).toBe("bottom");
    expect(placeMenu({ kind: "plate", plate: plate(700, y + 1), align: "end" }, MENU, SCREEN).side).toBe("top");
  });

  it("shifts right off the screen's left edge, still touching the plate", () => {
    const placement = placeMenu({ kind: "plate", plate: plate(20, 200), align: "end" }, MENU, SCREEN);
    expect(placement.menu.x).toBe(SCREEN.x + PAD);
    // Shifted no further than the plate's right edge (limitShift).
    const far = placeMenu({ kind: "plate", plate: plate(-400, 200), align: "end" }, MENU, SCREEN);
    expect(far.menu.x).toBe(-400 + 24);
  });

  it("shifts left off the right edge of a second screen", () => {
    const second: ScreenRect = { x: 1440, y: 0, width: 1920, height: 1080 };
    const placement = placeMenu({ kind: "plate", plate: plate(3350, 300), align: "start" }, MENU, second);
    expect(placement.menu.x).toBe(1440 + 1920 - PAD - 240);
  });

  it("takes the side that overflows least when neither fits, and is held to its room", () => {
    const short: ScreenRect = { x: 0, y: 0, width: 800, height: 400 };
    const placement = placeMenu({ kind: "plate", plate: plate(400, 150), align: "end" }, MENU, short);
    // Below: 400 − 8 − 178 = 214 of room; above: 146 − 8 = 138.
    expect(placement.side).toBe("bottom");
    expect(placement.maxHeight).toBe(400 - PAD - 178);
    expect(placement.menu.height).toBe(placement.maxHeight);
  });
});

describe("placeMenu at the pointer", () => {
  it("opens right of the pointer, its top at the pointer", () => {
    const placement = placeMenu({ kind: "point", point: { x: 500, y: 300 } }, MENU, SCREEN);
    expect(placement.side).toBe("right");
    expect(placement.menu.x).toBe(500 + CONTEXT_MENU_OFFSET_PX);
    expect(placement.menu.y).toBe(300);
  });

  it("flips left of the pointer at the screen's right edge", () => {
    const placement = placeMenu({ kind: "point", point: { x: 1300, y: 300 } }, MENU, SCREEN);
    expect(placement.side).toBe("left");
    expect(placement.menu.x + placement.menu.width).toBe(1300 - CONTEXT_MENU_OFFSET_PX);
  });

  it("rises off the screen's bottom, its bottom at most the pointer away", () => {
    const placement = placeMenu({ kind: "point", point: { x: 500, y: 850 } }, MENU, SCREEN);
    expect(placement.menu.y + placement.menu.height).toBe(SCREEN.y + SCREEN.height - PAD);
  });
});

describe("submenuSide", () => {
  it("opens right where it fits and left at the screen's right edge", () => {
    expect(submenuSide({ x: 400, y: 100, width: 240, height: 300 }, MENU_SEARCH_WIDTH_PX, SCREEN)).toBe("right");
    expect(submenuSide({ x: 1000, y: 100, width: 240, height: 300 }, MENU_SEARCH_WIDTH_PX, SCREEN)).toBe("left");
  });

  it("keeps right when neither side fits and the right overflows least", () => {
    const narrow: ScreenRect = { x: 0, y: 0, width: 600, height: 800 };
    expect(submenuSide({ x: 100, y: 100, width: 240, height: 300 }, MENU_SEARCH_WIDTH_PX, narrow)).toBe("right");
  });
});

describe("the panel's place", () => {
  it("holds the menu and its submenu's side with the shadow's field round them", () => {
    const layout = layoutPanel({ kind: "plate", plate: plate(700, 200), align: "end" }, MENU, SCREEN);
    const { menu } = layout.placement;
    expect(layout.submenu).toBe("right");
    expect(layout.origin.x).toBe(menu.x - FIELD);
    expect(layout.origin.x + MENU_PANEL_SIZE.width).toBe(menu.x + menu.width + MENU_SEARCH_WIDTH_PX + FIELD);
    expect(layout.origin.y).toBeLessThanOrEqual(menu.y - FIELD);
    // Below everything the tallest submenu could cover, its field below it:
    // nothing moves in the panel.
    expect(layout.origin.y + MENU_PANEL_SIZE.height).toBe(
      menu.y + SUBMENU_TRIGGER_INSET_PX + MENU_PANEL_SUBMENU_MAX_HEIGHT_PX + FIELD,
    );
  });

  it("puts its right edge the field off the menu when the submenu opens left", () => {
    const layout = layoutPanel({ kind: "plate", plate: plate(1200, 200), align: "end" }, MENU, SCREEN);
    expect(layout.submenu).toBe("left");
    const { menu } = layout.placement;
    expect(layout.origin.x + MENU_PANEL_SIZE.width).toBe(menu.x + menu.width + FIELD);
    expect(menu.x - layout.origin.x).toBe(MENU_SEARCH_WIDTH_PX + FIELD);
  });

  it("presses the submenu to the screen's bottom, not the panel: the panel reaches past it by the field's rest", () => {
    const layout = layoutPanel({ kind: "point", point: { x: 300, y: 700 } }, MENU, SCREEN);
    const { menu } = layout.placement;
    const screenBottom = SCREEN.y + SCREEN.height;
    // The bounds Radix places in inside the panel end where the screen's do.
    expect(layout.origin.y + MENU_PANEL_SIZE.height - FIELD).toBe(screenBottom - PAD);
    expect(layout.origin.y + MENU_PANEL_SIZE.height).toBe(screenBottom - PAD + FIELD);
    // The menu itself stands the padding off the screen's bottom.
    expect(menu.y + menu.height).toBe(screenBottom - PAD);
    expect(layout.origin.y).toBeLessThanOrEqual(menu.y - FIELD);
  });

  it("presses the menu to the screen's side edge, the panel reaching past it", () => {
    const layout = layoutPanel({ kind: "plate", plate: plate(20, 200), align: "end" }, MENU, SCREEN);
    expect(layout.placement.menu.x).toBe(SCREEN.x + PAD);
    expect(layout.origin.x).toBe(SCREEN.x + PAD - FIELD);
  });

  it("holds every menu up to the tallest whole with its field, wherever it stands", () => {
    for (const height of [120, 300, 400]) {
      for (const y of [30, 300, 600, 880]) {
        for (const x of [0, 500, 1430]) {
          const layout = layoutPanel({ kind: "point", point: { x, y } }, { width: 240, height }, SCREEN);
          const { menu } = layout.placement;
          const origin = panelOrigin(layout.placement, layout.submenu, SCREEN);
          expect(menu.x - origin.x).toBeGreaterThanOrEqual(FIELD - 1e-9);
          expect(origin.x + MENU_PANEL_SIZE.width - (menu.x + menu.width)).toBeGreaterThanOrEqual(FIELD - 1e-9);
          expect(menu.y - origin.y).toBeGreaterThanOrEqual(FIELD - 1e-9);
          expect(origin.y + MENU_PANEL_SIZE.height - (menu.y + menu.height)).toBeGreaterThanOrEqual(FIELD - 1e-9);
        }
      }
    }
  });

  it("is 564 × 429 pt: the menu, the search submenu, their tallest, the field round them", () => {
    expect(MENU_PANEL_SIZE).toEqual({ width: 240 + 300 + 2 * 12, height: 405 + 2 * 12 });
  });
});

describe("the shadow's field", () => {
  // The reach of one CSS shadow layer past its box on each side: the offset,
  // the spread and the blur radius, as the blur fades out over it.
  function reach(layer: string) {
    const [x, y, blur, spread] = (layer.trim().match(/-?\d+(?:\.\d+)?px|\b0\b/g) ?? []).map((value) => Number.parseFloat(value));
    const out = (offset: number) => Math.max(0, offset + (spread ?? 0) + (blur ?? 0));
    return { top: out(-(y ?? 0)), bottom: out(y ?? 0), left: out(-(x ?? 0)), right: out(x ?? 0) };
  }

  it("holds the menu's shadow whole on every side", () => {
    const theme = readFileSync("node_modules/tailwindcss/theme.css", "utf8");
    const token = /--shadow-md:\s*([^;]+);/.exec(theme)?.[1];
    expect(token).toBeTruthy();
    const layers = (token ?? "").split(/,(?![^(]*\))/).map(reach);
    const widest = Math.max(...layers.flatMap((side) => [side.top, side.bottom, side.left, side.right]));
    expect(widest).toBe(9);
    expect(widest).toBeLessThanOrEqual(MENU_SHADOW_FIELD_PX);
    // The menu's surface is the one that draws it, on the page and in the panel.
    expect(readFileSync("src/components/ui/dropdown-menu.tsx", "utf8")).toMatch(/rounded-1 border p-surface shadow-md/);
  });
});

describe("panelAnchor", () => {
  const origin = { x: 100, y: 50 };
  it("stands the plate gap above the menu's right edge for a menu below a button", () => {
    const anchor = panelAnchor({ menu: { x: 200, y: 150, width: 240, height: 300 }, side: "bottom", align: "end", maxHeight: null }, origin);
    expect(anchor).toEqual({ x: 340, y: 100 - MENU_PLATE_GAP_PX });
  });

  it("stands below the menu for a menu above its button", () => {
    const anchor = panelAnchor({ menu: { x: 200, y: 150, width: 240, height: 300 }, side: "top", align: "end", maxHeight: null }, origin);
    expect(anchor).toEqual({ x: 340, y: 400 + MENU_PLATE_GAP_PX });
  });

  it("stands left of a context menu and right of a flipped one", () => {
    const rect = { x: 200, y: 150, width: 240, height: 300 };
    expect(panelAnchor({ menu: rect, side: "right", align: "start", maxHeight: null }, origin)).toEqual({ x: 100 - MENU_PLATE_GAP_PX, y: 100 });
    expect(panelAnchor({ menu: rect, side: "left", align: "start", maxHeight: null }, origin)).toEqual({ x: 340 + MENU_PLATE_GAP_PX, y: 100 });
  });
});

describe("fitsPanel", () => {
  it("takes the card menu and refuses what the panel cannot hold", () => {
    expect(fitsPanel({ width: 240, height: 325 })).toBe(true);
    expect(fitsPanel({ width: 240, height: 401 })).toBe(false);
    expect(fitsPanel({ width: 300, height: 200 })).toBe(false);
  });
});
