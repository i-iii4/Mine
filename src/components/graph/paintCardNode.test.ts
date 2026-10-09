// A card on the graph: the chrome's plane and the foreground's text for a text
// thumbnail, the frame of a secondary button (DESIGN_SYSTEM.md, «Граф»).

import { describe, expect, it } from "vitest";
import { paintCardNode } from "./canvas";
import type { GraphCanvasTheme, PositionedGraphCanvasNode } from "./contracts";

const THEME: GraphCanvasTheme = {
  linkDefault: "border",
  chromeFill: "chrome",
  border: "border",
  mutedText: "muted",
  foregroundText: "foreground",
  hoverOutline: "hover",
};

/** The fills and strokes a paint made, in order. */
function recordingContext() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    filter: "none",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    save() {},
    restore() {},
    clip() {},
    fill() { calls.push(`fill ${this.fillStyle}`); },
    stroke() { calls.push(`stroke ${this.strokeStyle}`); },
    drawImage() { calls.push("image"); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function card(kind: "text" | "image" | null): PositionedGraphCanvasNode {
  return {
    id: "card:a",
    slug: "a",
    x: 0,
    y: 0,
    preview_manifest: kind === null ? null : JSON.stringify({
      kind,
      primary_preview_path: "a.png",
      width: 480,
      height: 480,
      preview_width: 480,
      preview_height: 480,
      tiles: [],
      overflow_count: 0,
    }),
  } as unknown as PositionedGraphCanvasNode;
}

function paint(node: PositionedGraphCanvasNode, picture: boolean, state: { hovered?: boolean; selected?: boolean } = {}) {
  const { ctx, calls } = recordingContext();
  const image = Object.assign(new Image(), { width: 480, height: 480 });
  paintCardNode(ctx, node, {
    globalScale: 1,
    canvasTheme: THEME,
    imageCache: { get: () => (picture ? image : undefined) } as unknown as Map<string, HTMLImageElement>,
    thumbsRootPath: "/thumbs",
    thumbVersion: 0,
    renderThumbnail: true,
    selected: state.selected ?? false,
    hovered: state.hovered ?? false,
    screenSize: 96,
    targetScreenSize: 96,
  });
  return calls;
}

describe("paintCardNode", () => {
  it("lays a text thumbnail on the chrome, its text over it, and frames it with the line", () => {
    expect(paint(card("text"), true)).toEqual(["fill chrome", "image", "stroke border"]);
  });

  it("gives a card with no picture the same plane and frame", () => {
    expect(paint(card("image"), false)).toEqual(["fill chrome", "stroke border"]);
  });

  it("frames a picture at rest with the same line", () => {
    expect(paint(card("image"), true)).toEqual(["image", "stroke border"]);
  });

  it("lights the frame under the pointer and while selected, on every card", () => {
    expect(paint(card("image"), true, { hovered: true })).toEqual(["image", "stroke hover"]);
    expect(paint(card("text"), true, { selected: true })).toEqual(["fill chrome", "image", "stroke hover"]);
  });
});
