import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_PREVIEW_TILE_GAP_PX, SIDEBAR_PREVIEW_TILE_PX, sidebarCompactRowsBelowPx } from "./appLayout";
import { CHANNEL_ICON_SPRING_EASING, CHANNEL_ICON_SPRING_MS, SPRING_SAMPLES } from "./channelIcon";
import { setListStyle } from "./compactStack";
import { setMotionLevel } from "@/test/motionLevel";
import {
  LIST_MORPH_FADE_IN_FROM_MS,
  LIST_MORPH_FADE_OUT_MS,
  LIST_MORPH_SETTLE_MS,
  LIST_MORPH_STEP_LIMIT_PX,
  anchoredScroll,
  fadeShare,
  fadeTrack,
  firstShownRow,
  listRowAt,
  moveCurve,
  observeSidebarListMorph,
  rowOffsets,
  rowsOnTheWay,
  segmentAt,
  segmentToward,
  widthStep,
  type RowsLayout,
} from "./sidebarListMorph";

/// The rows' move between the List and the table (user's decision of
/// 01.11.2026; DESIGN_SYSTEM.md, «Переход между List и таблицей»).

const ROWS = 60;
const PORT = 600;
/** The List's field above its rows (`padding-block` of `[data-sidebar-rows]`). */
const LIST_FIELD = 8;

/** The List with rows `step` apart (Tight 24, the probe Table 40), each
 *  name in the middle of its row, as global.css lays it out. */
function listLayout(step = 24): RowsLayout {
  const rows = Array.from({ length: ROWS }, (_, index) => {
    const top = LIST_FIELD + index * step;
    return { top, bottom: top + step, anchor: top + step / 2 };
  });
  return { rows, maxScroll: LIST_FIELD * 2 + ROWS * step + 32 - PORT };
}

/** The table: rows 40 apart, each name in the middle above its line's pixel. */
function tableLayout(): RowsLayout {
  const rows = Array.from({ length: ROWS }, (_, index) => {
    const top = index * 40;
    return { top, bottom: top + 40, anchor: top + 19.5 };
  });
  return { rows, maxScroll: ROWS * 40 + 32 - PORT };
}

describe("the move's time", () => {
  it("is the stack spring's settling time, its first third and its half", () => {
    expect(LIST_MORPH_SETTLE_MS).toBe(CHANNEL_ICON_SPRING_MS);
    expect(LIST_MORPH_SETTLE_MS).toBe(441);
    expect(LIST_MORPH_FADE_OUT_MS).toBe(147);
    expect(LIST_MORPH_FADE_IN_FROM_MS).toBe(220.5);
    const spring = segmentToward(1, 0, 0).spring;
    expect(spring.durationMs).toBe(LIST_MORPH_SETTLE_MS);
  });

  it("fades the look being left out within the first third, from where it was", () => {
    expect(fadeShare("out", 0, 1)).toBe(1);
    expect(fadeShare("out", LIST_MORPH_FADE_OUT_MS / 2, 1)).toBeCloseTo(0.5, 10);
    expect(fadeShare("out", LIST_MORPH_FADE_OUT_MS, 1)).toBe(0);
    expect(fadeShare("out", LIST_MORPH_SETTLE_MS, 1)).toBe(0);
    expect(fadeShare("out", LIST_MORPH_FADE_OUT_MS / 2, 0.4)).toBeCloseTo(0.2, 10);
  });

  it("shows the look being reached from halfway, evenly, from where it was", () => {
    expect(fadeShare("in", 0, 0)).toBe(0);
    expect(fadeShare("in", LIST_MORPH_FADE_IN_FROM_MS, 0)).toBe(0);
    expect(fadeShare("in", (LIST_MORPH_FADE_IN_FROM_MS + LIST_MORPH_SETTLE_MS) / 2, 0)).toBeCloseTo(0.5, 10);
    expect(fadeShare("in", LIST_MORPH_SETTLE_MS, 0)).toBe(1);
    expect(fadeShare("in", 0, 0.7)).toBe(0.7);
    expect(fadeShare("in", LIST_MORPH_FADE_IN_FROM_MS, 0.7)).toBe(0.7);
    expect(fadeShare("in", (LIST_MORPH_FADE_IN_FROM_MS + LIST_MORPH_SETTLE_MS) / 2, 0.7)).toBeCloseTo(0.85, 10);
    expect(fadeShare("in", LIST_MORPH_SETTLE_MS, 0.7)).toBe(1);
  });

  it("plays each fade as its keyframes, linear between them", () => {
    for (const way of ["in", "out"] as const) {
      for (const from of [0, 0.3, 1]) {
        const track = fadeTrack(way, from);
        for (let step = 0; step <= 40; step += 1) {
          const elapsed = (step / 40) * track.durationMs;
          const at = elapsed / track.durationMs;
          const next = track.frames.findIndex((frame) => frame.offset >= at);
          const a = track.frames[Math.max(0, next - 1)]!;
          const b = track.frames[next]!;
          const share = b.offset === a.offset ? b.share : a.share + ((at - a.offset) / (b.offset - a.offset)) * (b.share - a.share);
          expect(share).toBeCloseTo(fadeShare(way, elapsed, from), 10);
        }
      }
    }
  });
});

describe("the rows' places", () => {
  it("spreads each row by the steps' difference times its place from the anchor", () => {
    const list = listLayout();
    const table = tableLayout();
    const tableScroll = anchoredScroll(list, table, 0);
    expect(tableScroll).toBe(0);
    const offsets = rowOffsets(list, table, 0, tableScroll);
    // A list at its top: the first row is the anchor, half a pixel off (the
    // List's field and the table's line), the rest 16 px a row further.
    offsets.forEach((offset, index) => expect(offset).toBeCloseTo(offsets[0]! - 16 * index, 10));
    expect(offsets[0]).toBeCloseTo(0.5, 10);
  });

  it("keeps the first row shown where it is, the list scrolled, going to the table", () => {
    const list = listLayout();
    const table = tableLayout();
    const listScroll = 300;
    const anchor = firstShownRow(list, listScroll);
    expect(anchor).toBe(12);
    const tableScroll = anchoredScroll(list, table, listScroll);
    const offsets = rowOffsets(list, table, listScroll, tableScroll);
    expect(offsets[anchor]).toBeCloseTo(0, 10);
    for (let index = anchor; index < anchor + 20; index += 1) {
      expect(offsets[index]).toBeCloseTo(-16 * (index - anchor), 10);
    }
  });

  it("gathers the rows to the first row shown, going back to the List", () => {
    const list = listLayout();
    const table = tableLayout();
    const tableScroll = 600;
    const anchor = firstShownRow(table, tableScroll);
    expect(anchor).toBe(15);
    const listScroll = anchoredScroll(table, list, tableScroll);
    const offsets = rowOffsets(list, table, listScroll, tableScroll);
    expect(offsets[anchor]).toBeCloseTo(0, 10);
    expect(offsets[anchor + 5]).toBeCloseTo(-16 * 5, 10);
  });

  it("lands at the nearest scroll the List can take at the list's end, every row moved alike", () => {
    const list = listLayout();
    const table = tableLayout();
    const tableScroll = table.maxScroll;
    const listScroll = anchoredScroll(table, list, tableScroll);
    expect(listScroll).toBe(list.maxScroll);
    const offsets = rowOffsets(list, table, listScroll, tableScroll);
    const anchor = firstShownRow(table, tableScroll);
    const extra = offsets[anchor]!;
    expect(extra).toBeGreaterThan(0);
    expect(offsets[anchor + 3]).toBeCloseTo(extra - 16 * 3, 10);
  });

  it("with the List spacing probe at the table's step, only fades run in a scrolled list", () => {
    const list = listLayout(40);
    const table = tableLayout();
    const tableScroll = anchoredScroll(list, table, 200);
    rowOffsets(list, table, 200, tableScroll).forEach((offset) => expect(offset).toBeCloseTo(0, 10));
    // At its top the list stays at its top: the List's field and the line's
    // pixel, 8.5 px, are the move.
    expect(anchoredScroll(list, table, 0)).toBe(0);
    rowOffsets(list, table, 0, 0).forEach((offset) => expect(offset).toBeCloseTo(8.5, 10));
  });

  it("moves only the rows whose way crosses the scrollport", () => {
    const list = listLayout();
    const table = tableLayout();
    const offsets = rowOffsets(list, table, 300, anchoredScroll(list, table, 300));
    const tableScroll = anchoredScroll(list, table, 300);
    const shown = rowsOnTheWay(table, offsets, tableScroll, PORT);
    // Down to the last row the List shows. Above the anchor (12) only the
    // row whose table box, taller than the List's, still reaches into the
    // scrollport at the List's place; the one above it does not.
    expect(shown[0]).toBe(11);
    const lastInList = list.rows.findIndex((row) => row.top - 300 >= PORT) - 1;
    expect(lastInList).toBe(37);
    expect(shown).toEqual(Array.from({ length: lastInList - 10 }, (_, index) => 11 + index));
  });
});

describe("the move's spring", () => {
  it("is played by the spring's own samples, the points of its linear() easing", () => {
    const curve = moveCurve(segmentToward(1, 0, 0));
    expect(curve).toHaveLength(SPRING_SAMPLES + 1);
    const points = /^linear\((.*)\)$/.exec(CHANNEL_ICON_SPRING_EASING)![1]!.split(",").map(Number);
    curve.forEach((frame, index) => {
      expect(frame.offset).toBeCloseTo(index / SPRING_SAMPLES, 10);
      // From the List (1) to the table (0): one less the eased progress.
      expect(frame.q).toBeCloseTo(1 - points[index]!, 4);
    });
  });

  it("turns round without a jump: from where it is, at the speed it had", () => {
    const out = segmentToward(1, 0, 0);
    const frame = 1000 / 60;
    const at = out.spring.durationMs / 8;
    const { q, speed } = segmentAt(out, at);
    const step = q - segmentAt(out, at - frame).q;
    expect(step).toBeLessThan(0);
    const back = segmentToward(q, 1, speed);
    expect(segmentAt(back, 0).q).toBe(q);
    // The first frame back still goes the old way, slower than the last
    // one did: the new target pulls, the speed carries on.
    const first = segmentAt(back, frame).q - q;
    expect(first).toBeLessThan(0);
    expect(first).toBeGreaterThan(step);
    expect(segmentAt(back, back.spring.durationMs).q).toBe(1);
  });
});

describe("a Contents row in the List", () => {
  const model = { line: 16, pad: 4, anchorInCell: 8, one: { height: 26, anchor: 13, count: 6 } };

  it("stands a name of one line as the List laid it out", () => {
    expect(listRowAt(model, 16)).toEqual(model.one);
  });

  it("stands a name of more by its lines and its padding, the count on the last line", () => {
    expect(listRowAt(model, 32)).toEqual({ height: 40, anchor: 12, count: 20 });
    expect(listRowAt(model, 48)).toEqual({ height: 56, anchor: 12, count: 36 });
  });
});

describe("a width's step", () => {
  const threshold = sidebarCompactRowsBelowPx();
  const at = (width: number, previous: number | null, movingToTable: boolean | null = null, active = true) =>
    widthStep({ active, threshold, width, previous, movingToTable });

  it("rests without a crossing, the look following the width", () => {
    expect(at(400, null)).toBe("rest");
    expect(at(400, 380)).toBe("rest");
    expect(at(300, 320)).toBe("rest");
  });

  it("starts at a crossing, either way, by up to a tile and its gap", () => {
    expect(LIST_MORPH_STEP_LIMIT_PX).toBe(SIDEBAR_PREVIEW_TILE_PX + SIDEBAR_PREVIEW_TILE_GAP_PX);
    expect(LIST_MORPH_STEP_LIMIT_PX).toBe(36);
    expect(at(threshold, threshold - 0.1)).toBe("start");
    expect(at(threshold - 0.1, threshold)).toBe("start");
    expect(at(threshold + 10, threshold + 10 - LIST_MORPH_STEP_LIMIT_PX)).toBe("start");
  });

  it("switches at once for a larger step: a fast drag, Home and End, a snapped window", () => {
    expect(at(threshold + 40, threshold - 32)).toBe("instant");
    expect(at(2170, 280)).toBe("instant");
    expect(at(280, 2170)).toBe("instant");
    // Back across mid-move, by as much.
    expect(at(300, 380, true)).toBe("instant");
  });

  it("goes on with the width on its side and turns at a crossing back", () => {
    expect(at(420, 400, true)).toBe("go-on");
    expect(at(360, 372, true)).toBe("turn");
    expect(at(300, 320, false)).toBe("go-on");
    expect(at(372, 360, false)).toBe("turn");
    // Far on its side, at any speed.
    expect(at(1400, 400, true)).toBe("go-on");
  });

  it("does nothing with Reduce motion or a list not laid out", () => {
    expect(at(400, 300, null, false)).toBe("idle");
    expect(at(300, 400, true, false)).toBe("idle");
    expect(at(0, 400)).toBe("idle");
  });
});

// ─── The DOM ────────────────────────────────────────────────────────────

/** The Contents count's place in the List: below its row's top by this,
 *  this far in from the row body's right edge; and in the table. */
const LIST_COUNT = { top: 4, inset: 16 };
const TABLE_COUNT = { top: 12, inset: 17 };

const threshold0 = () => sidebarCompactRowsBelowPx();

/** A list scrollport of `ROWS` rows laid out by its look, as the stylesheet
 *  lays it out: the List in the compact look, the table otherwise. Every
 *  look it is put in is logged. */
function mountList(width = 400) {
  const threshold = sidebarCompactRowsBelowPx();
  const nav = document.createElement("nav");
  nav.setAttribute("data-sidebar-scroll", "");
  const rowsBox = document.createElement("div");
  rowsBox.setAttribute("data-sidebar-rows", "");
  nav.appendChild(rowsBox);
  const rows: HTMLElement[] = Array.from({ length: ROWS }, () => {
    const row = document.createElement("div");
    row.setAttribute("data-sidebar-row-surface", "");
    const name = document.createElement("span");
    name.setAttribute("data-sidebar-name-text", "");
    row.appendChild(name);
    rowsBox.appendChild(row);
    return row;
  });
  document.body.appendChild(nav);
  const state = { width, scroll: 0, looks: [] as string[] };
  const setAttribute = nav.setAttribute.bind(nav);
  nav.setAttribute = (name: string, value: string) => {
    if (name === "data-sidebar-look") state.looks.push(value);
    setAttribute(name, value);
  };
  const isList = () => nav.getAttribute("data-sidebar-look") === "compact";
  const layout = () => (isList() ? listLayout() : tableLayout());
  const rect = (top: number, height: number) => ({ x: 0, y: top, top, left: 0, right: state.width, bottom: top + height, width: state.width, height, toJSON: () => ({}) });
  nav.getBoundingClientRect = () => rect(0, PORT) as DOMRect;
  Object.defineProperty(nav, "clientHeight", { configurable: true, get: () => PORT });
  Object.defineProperty(nav, "scrollHeight", { configurable: true, get: () => layout().maxScroll + PORT });
  Object.defineProperty(nav, "scrollTop", {
    configurable: true,
    get: () => state.scroll,
    set: (value: number) => {
      state.scroll = Math.min(Math.max(0, value), Math.max(0, layout().maxScroll));
    },
  });
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => {
      const place = layout().rows[index]!;
      return rect(place.top - state.scroll, place.bottom - place.top) as DOMRect;
    };
    const name = row.firstElementChild!;
    name.getClientRects = () => {
      const place = layout().rows[index]!;
      return [rect(place.anchor - state.scroll - 8, 16)] as unknown as DOMRectList;
    };
  });
  /** Gives each row the Contents list's body and count. */
  const withCounts = () => rows.forEach((row, index) => {
    const body = document.createElement("a");
    body.setAttribute("data-sidebar-row-body", "");
    body.setAttribute("data-sidebar-count", String(index));
    const count = document.createElement("span");
    count.setAttribute("data-sidebar-meta-count", "");
    body.appendChild(count);
    row.appendChild(body);
    body.getBoundingClientRect = () => row.getBoundingClientRect();
    count.getBoundingClientRect = () => {
      const place = layout().rows[index]!;
      const at = isList() ? LIST_COUNT : TABLE_COUNT;
      const top = place.top + at.top - state.scroll;
      return { x: state.width - at.inset - 20, y: top, top, bottom: top + 16, left: state.width - at.inset - 20, right: state.width - at.inset, width: 20, height: 16, toJSON: () => ({}) } as DOMRect;
    };
  });
  return { nav, rows, state, threshold, withCounts };
}

interface Played {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

describe("the scrollport", () => {
  let played: Played[];
  let report: (width: number) => void;
  /** The frames asked for, run by `nextFrame`. */
  let frames: FrameRequestCallback[];
  const nextFrame = () => {
    const due = frames;
    frames = [];
    for (const callback of due) callback(0);
  };

  beforeEach(() => {
    played = [];
    frames = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        report = (width) => callback([{ contentBoxSize: [{ inlineSize: width, blockSize: PORT }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    // An engine that animates pseudo-elements.
    vi.stubGlobal("KeyframeEffect", class {
      pseudoElement: string | null;
      constructor(_target: Element | null, _frames: Keyframe[] | null, options?: KeyframeEffectOptions) {
        this.pseudoElement = options?.pseudoElement ?? null;
      }
    });
    Element.prototype.animate = function animate(this: Element, keyframes, options) {
      played.push({ element: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions });
      return {
        finished: new Promise(() => {}),
        currentTime: 0,
        startTime: null,
        pause() {},
        cancel() {},
      } as unknown as Animation;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<Element>).animate;
    document.body.innerHTML = "";
  });

  const moves = (rows: HTMLElement[]) => played.filter((play) => rows.includes(play.element as HTMLElement) && play.keyframes.some((frame) => frame.transform !== undefined));

  it("puts the scrollport in its look before it is first painted, and keeps the table while it is the look", () => {
    const { nav, state, threshold } = mountList(sidebarCompactRowsBelowPx() + 10);
    const stop = observeSidebarListMorph(nav);
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    report(state.width);
    // Narrowed across: the table stays laid out while the rows gather.
    state.width = threshold - 10;
    report(state.width);
    expect(nav.getAttribute("data-sidebar-rows-fade")).toBe("list");
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    // The table's parts leave the layout once they are gone, by the end of
    // the first third.
    expect(played.some((play) => play.keyframes.length === 0 && play.options.duration === LIST_MORPH_FADE_OUT_MS)).toBe(true);
    stop();
    // The move ends where it was going: the List.
    expect(nav.getAttribute("data-sidebar-look")).toBe("compact");
  });

  it("starts each row at the List's place in the frame that crossed, and moves it from the next", () => {
    const { nav, rows, state, threshold } = mountList(sidebarCompactRowsBelowPx() - 10);
    const stop = observeSidebarListMorph(nav);
    expect(nav.getAttribute("data-sidebar-look")).toBe("compact");
    report(state.width);
    nav.scrollTop = 300;
    state.width = threshold + 10;
    report(state.width);
    // The look is the table in the frame that crossed, before it paints.
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    const list = listLayout();
    const table = tableLayout();
    const tableScroll = anchoredScroll(list, table, 300);
    expect(nav.scrollTop).toBe(tableScroll);
    const offsets = rowOffsets(list, table, 300, tableScroll);
    const shown = rowsOnTheWay(table, offsets, tableScroll, PORT).filter((index) => Math.abs(offsets[index]!) > 0.01);
    // That frame writes each row where it starts and makes no animation of it.
    expect(moves(rows)).toEqual([]);
    // A row's start is its own `translate`, not its `transform`.
    for (const index of shown) {
      expect(rows[index]!.style.translate).toBe(`0px ${offsets[index]}px`);
      expect(rows[index]!.style.transform).toBe("");
    }
    nextFrame();
    const moved = moves(rows);
    expect(moved.map((play) => rows.indexOf(play.element as HTMLElement))).toEqual(shown);
    const curve = moveCurve(segmentToward(1, 0, 0));
    for (const play of moved) {
      const index = rows.indexOf(play.element as HTMLElement);
      // From the List's place (List-ness 1) to the table's, on the spring's
      // samples, linear between them; the written place gives way to it.
      expect(play.keyframes).toHaveLength(curve.length);
      expect(play.keyframes[0]!.transform).toBe(`translate(0px, ${offsets[index]}px)`);
      expect(play.keyframes[curve.length - 1]!.transform).toBe("translate(0px, 0px)");
      expect(play.keyframes[10]!.offset).toBeCloseTo(curve[10]!.offset, 10);
      expect(play.options.duration).toBe(LIST_MORPH_SETTLE_MS);
      expect(play.options.easing).toBeUndefined();
      expect(rows[index]!.style.translate).toBe("");
      expect(rows[index]!.style.transform).toBe("");
    }
    // The rows' lines fade by animations of their own.
    expect(played.some((play) => rows.includes(play.element as HTMLElement) && play.options.pseudoElement === "::after")).toBe(true);
    stop();
  });

  it("switches at once, with no move, when the width crosses by more than a tile and its gap", () => {
    const { nav, rows, state, threshold } = mountList(sidebarCompactRowsBelowPx() - 20);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold - 20 + LIST_MORPH_STEP_LIMIT_PX + 1;
    report(state.width);
    nextFrame();
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    expect(nav.hasAttribute("data-sidebar-rows-fade")).toBe(false);
    expect(played).toEqual([]);
    expect(rows.every((row) => row.style.transform === "" && row.style.translate === "")).toBe(true);
    // Back by as much, at once again.
    state.width = threshold - 20;
    report(state.width);
    expect(nav.getAttribute("data-sidebar-look")).toBe("compact");
    expect(played).toEqual([]);
    stop();
  });

  it("keeps the List's places from a frame that laid it out, until a row changes", async () => {
    const { nav, rows, state, threshold } = mountList(sidebarCompactRowsBelowPx() - 20);
    const rail = document.createElement("div");
    rail.setAttribute("data-sidebar-preview-rail", "");
    rows[2]!.appendChild(rail);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    // To the table at once, then back by a small step: the List kept from
    // its rest is the one the rows gather to, with no List laid out for it.
    state.width = threshold + 30;
    report(state.width);
    state.width = threshold + 5;
    report(state.width);
    // A strip's tiles change with the width inside a cell the List hides.
    rail.appendChild(document.createElement("span"));
    await Promise.resolve();
    state.looks = [];
    state.width = threshold - 5;
    report(state.width);
    expect(nav.getAttribute("data-sidebar-rows-fade")).toBe("list");
    expect(state.looks).toEqual([]);
    stop();
    // A row renamed: its places are read with the List laid out for the read.
    const again = mountList(sidebarCompactRowsBelowPx() - 20);
    const stopAgain = observeSidebarListMorph(again.nav);
    report(again.state.width);
    again.state.width = threshold + 30;
    report(again.state.width);
    again.state.width = threshold + 5;
    report(again.state.width);
    again.rows[3]!.firstElementChild!.textContent = "Renamed";
    await Promise.resolve();
    again.state.looks = [];
    again.state.width = threshold - 5;
    report(again.state.width);
    expect(again.state.looks).toEqual(["compact", "table"]);
    stopAgain();
  });

  /** Wraps each row's name in its cell, laid out as each look lays it out:
   *  in the List from 16px to 8px short of the scrollport's right edge, in
   *  the table from 0 in a 133px column; the text from 17px, `textWidth`
   *  wide. The cell keeps a 3px clear tail and a 24px dissolve. */
  const withNames = (nav: HTMLElement, rows: HTMLElement[], state: { width: number }, textWidth: (index: number) => number, lines: (index: number) => number = () => 1) => rows.map((row, index) => {
    const text = row.querySelector<HTMLElement>("[data-sidebar-name-text]")!;
    const cell = document.createElement("span");
    cell.setAttribute("data-sidebar-name-cell", "");
    cell.setAttribute("data-sidebar-title-protected-width", "3");
    cell.setAttribute("data-sidebar-title-fade-width", "24");
    row.insertBefore(cell, text);
    cell.appendChild(text);
    const list = () => nav.getAttribute("data-sidebar-look") === "compact";
    // In Contents' List, and through the move, the name stands in its lines.
    const lined = () => list() || cell.hasAttribute("data-sidebar-name-slide");
    const box = (left: number, right: number, height = 16) => ({ x: left, y: 0, top: 0, bottom: height, left, right, width: right - left, height, toJSON: () => ({}) }) as DOMRect;
    cell.getBoundingClientRect = () => (list() ? box(16, state.width - 8, 16 * lines(index)) : box(0, 133));
    text.getBoundingClientRect = () => box(17, 17 + textWidth(index), lined() ? 16 * lines(index) : 16);
    return cell;
  });
  const slideOf = (cell: HTMLElement) => played.find((play) => play.element === cell && play.keyframes.some((frame) => "--sidebar-name-q" in frame));

  it("slides the visible end of a name one look cuts, on the rows' spring; a name that fits both stays", () => {
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    const { nav, rows, state, threshold } = mountList(threshold0() - 10);
    const cells = withNames(nav, rows, state, (index) => (index === 2 ? 60 : 200));
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    const [, cut, short] = cells;
    expect(cut!.hasAttribute("data-sidebar-name-slide")).toBe(true);
    expect(short!.hasAttribute("data-sidebar-name-slide")).toBe(false);
    // The table cuts it at its column, the List shows it whole: the List's
    // end lies past the text and its dissolve. The List's end stands 8px
    // short of the scrollport, the panel's border past it, the cell 0px in.
    expect(cut!.style.getPropertyValue("--sidebar-name-edge-table")).toBe("var(--sidebar-name-table-w)");
    expect(cut!.style.getPropertyValue("--sidebar-name-edge-list")).toBe(`max(var(--sidebar-name-list-w), ${17 + 200 + 3 + 24}px)`);
    expect(cut!.style.getPropertyValue("--sidebar-name-list-inset")).toBe("9px");
    // The frame that crossed holds the end at the List's; the next one
    // moves it to the table's on the spring's samples.
    expect(cut!.style.getPropertyValue("--sidebar-name-q")).toBe("1");
    expect(slideOf(cut!)).toBeUndefined();
    nextFrame();
    const slide = slideOf(cut!)!;
    const curve = moveCurve(segmentToward(1, 0, 0));
    expect(slide.keyframes).toHaveLength(curve.length);
    expect(slide.keyframes[0]!["--sidebar-name-q"]).toBe(1);
    expect(slide.keyframes[curve.length - 1]!["--sidebar-name-q"]).toBe(0);
    expect(slide.options.duration).toBe(LIST_MORPH_SETTLE_MS);
    expect(cut!.style.getPropertyValue("--sidebar-name-q")).toBe("");
    expect(slideOf(short!)).toBeUndefined();
    // The move ends: the cell is the table's again.
    stop();
    expect(cut!.hasAttribute("data-sidebar-name-slide")).toBe(false);
    expect(cut!.style.getPropertyValue("--sidebar-name-list-inset")).toBe("");
    expect(cut!.style.getPropertyValue("--sidebar-name-edge-list")).toBe("");
  });

  it("moves a name's List end past its text once a drag going on makes the List wide enough for it", () => {
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    const { nav, rows, state, threshold } = mountList(threshold0() - 10);
    // 360px of text: cut by the List 10px past the threshold, whole 30px past it.
    const cells = withNames(nav, rows, state, () => 360);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    expect(cells[1]!.style.getPropertyValue("--sidebar-name-edge-list")).toBe("var(--sidebar-name-list-w)");
    state.width = threshold + 30;
    report(state.width);
    expect(cells[1]!.style.getPropertyValue("--sidebar-name-edge-list")).toBe(`max(var(--sidebar-name-list-w), ${17 + 360 + 3 + 24}px)`);
    stop();
  });

  it("moves the rows on whole device pixels, so they stand sharp at their last place before the landing", () => {
    const { nav, rows, state, threshold } = mountList(threshold0() + 10);
    const ratio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold - 10;
    report(state.width);
    nextFrame();
    const play = moves(rows)[5]!;
    for (const frame of play.keyframes) {
      const y = Number(/translate\([^,]+, (-?[\d.]+)px\)/.exec(String(frame.transform))![1]);
      expect(y * 2).toBe(Math.round(y * 2));
    }
    stop();
    if (ratio) Object.defineProperty(window, "devicePixelRatio", ratio);
    else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
  });

  it("keeps whole, going to the List, a name that only a narrower width cuts; the move to the table leaves it", () => {
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    const { nav, rows, state, threshold } = mountList(threshold0() + 10);
    // 100px of text: whole in the table's 133px column now, cut in the column
    // the narrowest sidebar leaves it. 60px: no width cuts it.
    const cells = withNames(nav, rows, state, (index) => (index === 2 ? 60 : 100));
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold - 10;
    report(state.width);
    expect(cells[1]!.hasAttribute("data-sidebar-name-whole")).toBe(true);
    expect(cells[1]!.hasAttribute("data-sidebar-name-slide")).toBe(false);
    expect(cells[2]!.hasAttribute("data-sidebar-name-whole")).toBe(false);
    nextFrame();
    expect(slideOf(cells[1]!)).toBeUndefined();
    stop();
    expect(cells[1]!.hasAttribute("data-sidebar-name-whole")).toBe(false);

    document.body.innerHTML = "";
    const up = mountList(threshold0() - 10);
    const upCells = withNames(up.nav, up.rows, up.state, () => 100);
    const stopUp = observeSidebarListMorph(up.nav);
    report(up.state.width);
    up.state.width = threshold + 10;
    report(up.state.width);
    expect(upCells[1]!.hasAttribute("data-sidebar-name-whole")).toBe(false);
    stopUp();
  });

  it("slides a name without the previews too, the table's end by what the meta zone leaves", () => {
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    document.documentElement.setAttribute("data-sidebar-hide-previews", "");
    const { nav, rows, state, threshold } = mountList(threshold0() - 10);
    const cells = withNames(nav, rows, state, () => 200);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    const cell = cells[1]!;
    expect(cell.hasAttribute("data-sidebar-name-slide")).toBe(true);
    // The cell ends 133px in, the scrollport's width from it, the panel's border past it.
    expect(cell.style.getPropertyValue("--sidebar-name-table-inset")).toBe(`${state.width - 133 + 1}px`);
    stop();
    expect(cell.style.getPropertyValue("--sidebar-name-table-inset")).toBe("");
    document.documentElement.removeAttribute("data-sidebar-hide-previews");
  });

  it("slides a Contents name too, in the List's lines, so the landing lifts nothing", () => {
    setListStyle("contents");
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    const { nav, rows, state, threshold, withCounts } = mountList(threshold0() - 10);
    withCounts();
    const cells = withNames(nav, rows, state, () => 200, (index) => (index === 1 ? 2 : 1));
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    const cell = cells[1]!;
    expect(cell.hasAttribute("data-sidebar-name-slide")).toBe(true);
    expect(cell.style.getPropertyValue("--sidebar-name-list-h")).toBe("32px");
    expect(cells[0]!.style.getPropertyValue("--sidebar-name-list-h")).toBe("16px");
    // The table cuts its one line at the column; the List cuts nothing, and
    // its end lies past its edge and the dissolve.
    expect(cell.style.getPropertyValue("--sidebar-name-edge-table")).toBe("var(--sidebar-name-table-w)");
    expect(cell.style.getPropertyValue("--sidebar-name-edge-list")).toBe(`calc(var(--sidebar-name-list-w) + ${3 + 24}px)`);
    nextFrame();
    expect(slideOf(cell)!.keyframes[0]!["--sidebar-name-q"]).toBe(1);
    stop();
    expect(cell.hasAttribute("data-sidebar-name-slide")).toBe(false);
    expect(cell.style.getPropertyValue("--sidebar-name-list-h")).toBe("");
    setListStyle("plain");
  });

  it("follows a Contents name's lines through a drag going on: the rows below land where the List stands them", () => {
    setListStyle("contents");
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    const { nav, rows, state, threshold, withCounts } = mountList(threshold0() - 10);
    withCounts();
    for (const row of rows) row.querySelector<HTMLElement>("[data-sidebar-row-body]")!.style.paddingTop = "4px";
    const lines = rows.map(() => 1);
    const cells = withNames(nav, rows, state, () => 200, (index) => lines[index]!);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    nextFrame();
    const body = rows[3]!.querySelector<HTMLElement>("[data-sidebar-row-body]")!;
    const topBefore = parseFloat(body.style.getPropertyValue("--sidebar-list-count-top"));
    const lastMove = (row: HTMLElement) => moves([row]).at(-1)!;
    const yOf = (play: Played) => Number(/translate\([^,]+, (-?[\d.]+)px\)/.exec(String(play.keyframes[0]!.transform))![1]);
    const below = yOf(lastMove(rows[4]!));
    const above = yOf(lastMove(rows[2]!));
    // No line changed: nothing is played again.
    const playedBefore = played.length;
    state.width = threshold + 12;
    report(state.width);
    expect(played.length).toBe(playedBefore);
    // The name now takes two lines.
    lines[3] = 2;
    state.width = threshold + 14;
    report(state.width);
    expect(cells[3]!.style.getPropertyValue("--sidebar-name-list-h")).toBe("32px");
    const model = { line: 16, pad: 4, anchorInCell: 20, one: { height: 24, anchor: 20, count: 12 } };
    const was = listRowAt(model, 16);
    const now = listRowAt(model, 32);
    expect(yOf(lastMove(rows[4]!))).toBeCloseTo(below + now.height - was.height, 6);
    // The rows above stay.
    expect(yOf(lastMove(rows[2]!))).toBe(above);
    expect(parseFloat(body.style.getPropertyValue("--sidebar-list-count-top"))).not.toBe(topBefore);
    stop();
    setListStyle("plain");
  });

  it("slides no name where the look changes at once", () => {
    vi.stubGlobal("CSS", { registerProperty: () => {} });
    const { nav, rows, state, threshold } = mountList(threshold0() - 10);
    const cells = withNames(nav, rows, state, () => 200);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold - 10 + LIST_MORPH_STEP_LIMIT_PX + 1;
    report(state.width);
    expect(cells.some((cell) => cell.hasAttribute("data-sidebar-name-slide"))).toBe(false);
    stop();
  });

  it("keeps the open width's look through a collapse and an opening, with no switch and no move", async () => {
    const { nav, state, threshold } = mountList(threshold0() + 50);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    // The collapse: the open panel is the rows and the panel's border wide.
    const open = String(state.width + 1);
    nav.setAttribute("data-sidebar-width-motion", open);
    await Promise.resolve();
    state.looks = [];
    for (const width of [threshold + 20, threshold - 4, threshold - 40, 279]) {
      state.width = width;
      report(width);
      nextFrame();
    }
    expect(state.looks.every((look) => look === "table")).toBe(true);
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    expect(nav.hasAttribute("data-sidebar-rows-fade")).toBe(false);
    expect(played).toEqual([]);
    // Collapsed, the motion over: the look follows the width at once.
    nav.removeAttribute("data-sidebar-width-motion");
    await Promise.resolve();
    expect(nav.getAttribute("data-sidebar-look")).toBe("compact");
    expect(played).toEqual([]);
    // The opening: the open width's look from its first frame to its last.
    nav.setAttribute("data-sidebar-width-motion", open);
    await Promise.resolve();
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    for (const width of [300, threshold - 4, threshold + 4, Number(open) - 1]) {
      state.width = width;
      report(width);
      nextFrame();
    }
    nav.removeAttribute("data-sidebar-width-motion");
    await Promise.resolve();
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    expect(nav.hasAttribute("data-sidebar-rows-fade")).toBe(false);
    expect(played).toEqual([]);
    // A drag of the edge across the threshold moves the rows again.
    for (const width of [threshold + 10, threshold - 4]) {
      state.width = width;
      report(width);
    }
    expect(nav.getAttribute("data-sidebar-rows-fade")).toBe("list");
    stop();
  });

  it("stays the List through the motion when the open width is the List's", async () => {
    const { nav, state, threshold } = mountList(threshold0() - 30);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    const open = String(state.width + 1);
    state.looks = [];
    nav.setAttribute("data-sidebar-width-motion", open);
    await Promise.resolve();
    for (const width of [threshold - 50, 279, threshold - 50, Number(open) - 1]) {
      state.width = width;
      report(width);
      nextFrame();
    }
    nav.removeAttribute("data-sidebar-width-motion");
    await Promise.resolve();
    expect(state.looks.every((look) => look === "compact")).toBe(true);
    expect(nav.getAttribute("data-sidebar-look")).toBe("compact");
    expect(played).toEqual([]);
    stop();
  });

  it("lands a move under way where it was going when the width starts to move", async () => {
    const { nav, state, threshold } = mountList(threshold0() - 10);
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    expect(nav.getAttribute("data-sidebar-rows-fade")).toBe("table");
    nav.setAttribute("data-sidebar-width-motion", String(state.width + 1));
    await Promise.resolve();
    expect(nav.hasAttribute("data-sidebar-rows-fade")).toBe(false);
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    stop();
  });

  it("fades the Contents count in the List and the table's as two parts, each at its own place", () => {
    setListStyle("contents");
    const { nav, rows, state, threshold, withCounts } = mountList(sidebarCompactRowsBelowPx() - 10);
    withCounts();
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold + 10;
    report(state.width);
    nextFrame();
    const body = rows[2]!.querySelector<HTMLElement>("[data-sidebar-row-body]")!;
    const count = rows[2]!.querySelector("[data-sidebar-meta-count]")!;
    // The List's count, on the row body at its place in the List.
    const list = listLayout().rows[2]!;
    const table = tableLayout().rows[2]!;
    const top = (list.top + LIST_COUNT.top - list.anchor) - (table.top - table.anchor);
    expect(body.style.getPropertyValue("--sidebar-list-count-top")).toBe(`${top}px`);
    expect(body.style.getPropertyValue("--sidebar-list-count-right")).toBe(`${LIST_COUNT.inset}px`);
    const listCount = played.find((play) => play.element === body && play.options.pseudoElement === "::after")!;
    expect(listCount.options.duration).toBe(LIST_MORPH_FADE_OUT_MS);
    expect(listCount.keyframes.map((frame) => frame.opacity)).toEqual([1, 0]);
    // The table's count, the count itself, from nothing from halfway on; it
    // does not slide.
    const tableCount = played.find((play) => play.element === count)!;
    expect(tableCount.options.duration).toBe(LIST_MORPH_SETTLE_MS);
    expect(tableCount.keyframes.map((frame) => frame.opacity)).toEqual([0, 0, 1]);
    expect(played.some((play) => play.element === count && play.keyframes.some((frame) => frame.transform !== undefined))).toBe(false);
    stop();
    expect(body.style.getPropertyValue("--sidebar-list-count-top")).toBe("");
    setListStyle("plain");
  });

  it.each(["minimal", "off"] as const)("moves nothing in %s: the look follows the width at once (SPEC_MOTION_LEVELS.md, С3)", (level) => {
    setMotionLevel(level);
    const { nav, state, threshold } = mountList();
    const stop = observeSidebarListMorph(nav);
    report(state.width);
    state.width = threshold - 20;
    report(state.width);
    expect(nav.getAttribute("data-sidebar-look")).toBe("compact");
    state.width = threshold + 20;
    report(state.width);
    nextFrame();
    expect(nav.getAttribute("data-sidebar-look")).toBe("table");
    expect(played).toEqual([]);
    expect(nav.hasAttribute("data-sidebar-rows-bare")).toBe(false);
    expect(nav.hasAttribute("data-sidebar-rows-fade")).toBe(false);
    stop();
  });
});
