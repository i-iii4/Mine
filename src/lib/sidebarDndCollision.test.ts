import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarDropIdFromPoint, sidebarPointerWithin } from "./sidebarDndCollision";

function row(rowKey: string): HTMLElement {
  const element = document.createElement("div");
  element.dataset.sidebarRow = "";
  element.dataset.sidebarRowKey = rowKey;
  document.body.appendChild(element);
  return element;
}

function mockElementsFromPoint(elements: Element[]) {
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: vi.fn(() => elements),
  });
}

function collisionArgs(overId: string) {
  const droppableContainer = {
    id: overId,
    key: overId,
    data: { current: {} },
    disabled: false,
    node: { current: document.createElement("div") },
    rect: { current: null },
  };
  return {
    active: {
      id: "card",
      data: { current: {} },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: {
      top: 0,
      left: 0,
      right: 1,
      bottom: 1,
      width: 1,
      height: 1,
    },
    droppableRects: new Map(),
    droppableContainers: [droppableContainer],
    pointerCoordinates: { x: 12, y: 34 },
  };
}

describe("sidebar dnd collision", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("resolves the actual sidebar row under the pointer", () => {
    const overlay = document.createElement("div");
    const beta = row("tag:beta");
    mockElementsFromPoint([overlay, beta]);

    expect(sidebarDropIdFromPoint({ x: 12, y: 34 })).toBe("tag:beta");
  });

  it("ignores Everything because it is navigation, not a card drop target", () => {
    const everything = row("all");
    mockElementsFromPoint([everything]);

    expect(sidebarDropIdFromPoint({ x: 12, y: 34 })).toBeNull();
  });

  it("prefers the row under the pointer over stale droppable rectangles", () => {
    const beta = row("tag:beta");
    mockElementsFromPoint([beta]);

    const [collision] = sidebarPointerWithin(collisionArgs("tag:beta"));

    expect(collision?.id).toBe("tag:beta");
    expect(collision?.data?.source).toBe("sidebar-pointer");
  });
});
