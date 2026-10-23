// A card on the graph: the chrome's plane and the foreground's text for a text
// thumbnail, the buttons' 0.5px edge (DESIGN_SYSTEM.md, «Граф»; 22.10.2026).

import { describe, expect, it } from "vitest";
import { GRAPH_CONTEXT_OPACITY } from "@/lib/colorLaw";
import { paintCardNode } from "./canvas";
import type { GraphCanvasTheme, PositionedGraphCanvasNode } from "./contracts";

const THEME: GraphCanvasTheme = {
  linkDefault: "border",
  chromeFill: "chrome",
  border: "border",
  mutedText: "muted",
  foregroundText: "foreground",
  hoverOutline: "pill-hover",
  cardOutline: "edge",
  cardHoverOutline: "edge-hover",
  canvasFill: "canvas",
};

/** The fills and strokes a paint made, in order, with the alpha of each. */
function recordingContext() {
  const calls: string[] = [];
  const alphas: number[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    filter: "none",
    globalAlpha: 1,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    save() {},
    restore() {},
    clip() {},
    fill() { calls.push(`fill ${this.fillStyle}`); alphas.push(this.globalAlpha); },
    stroke() { calls.push(`stroke ${this.strokeStyle}`); alphas.push(this.globalAlpha); },
    drawImage() { calls.push("image"); alphas.push(this.globalAlpha); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, alphas };
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
  return paintRecorded(node, picture, state).calls;
}

function paintRecorded(
  node: PositionedGraphCanvasNode,
  picture: boolean,
  state: { hovered?: boolean; selected?: boolean; opacity?: number } = {},
) {
  const { ctx, calls, alphas } = recordingContext();
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
    opacity: state.opacity ?? 1,
  });
  return { calls, alphas };
}

describe("paintCardNode", () => {
  it("lays a text thumbnail on the chrome, its text over it, and gives it the buttons' edge", () => {
    expect(paint(card("text"), true)).toEqual(["fill chrome", "image", "stroke edge"]);
  });

  it("gives a card with no picture the same plane and frame", () => {
    expect(paint(card("image"), false)).toEqual(["fill chrome", "stroke edge"]);
  });

  it("gives a picture at rest the same edge", () => {
    expect(paint(card("image"), true)).toEqual(["image", "stroke edge"]);
  });

  it("works the edge out with the state layer under the pointer and while selected, on every card", () => {
    expect(paint(card("image"), true, { hovered: true })).toEqual(["image", "stroke edge-hover"]);
    expect(paint(card("text"), true, { selected: true })).toEqual(["fill chrome", "image", "stroke edge-hover"]);
  });

  it("draws a dimmed card as itself under the canvas: the canvas first, then the card at the dimmed opacity", () => {
    // SPEC_GRAPH_VIEW.md, «Приглушение при наведении на коллекцию»: the
    // footprint is covered first so the lines beneath do not show through.
    const picture = paintRecorded(card("image"), true, { opacity: GRAPH_CONTEXT_OPACITY });
    expect(picture.calls).toEqual(["fill canvas", "image", "stroke edge"]);
    expect(picture.alphas).toEqual([1, GRAPH_CONTEXT_OPACITY, GRAPH_CONTEXT_OPACITY]);
    const text = paintRecorded(card("text"), true, { opacity: GRAPH_CONTEXT_OPACITY, selected: true });
    expect(text.calls).toEqual(["fill canvas", "fill chrome", "image", "stroke edge-hover"]);
    expect(text.alphas).toEqual([1, GRAPH_CONTEXT_OPACITY, GRAPH_CONTEXT_OPACITY, GRAPH_CONTEXT_OPACITY]);
  });

  it("paints an undimmed card without the canvas underlay or any change of alpha", () => {
    const rest = paintRecorded(card("text"), true, { opacity: 1 });
    expect(rest.calls).toEqual(["fill chrome", "image", "stroke edge"]);
    expect(rest.alphas).toEqual([1, 1, 1]);
  });
});
