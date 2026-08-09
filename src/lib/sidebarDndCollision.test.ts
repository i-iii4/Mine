import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarDropIdFromPoint, sidebarPointerWithin } from "./sidebarDndCollision";

function rect(top: number, height: number) {
  return { top, left: 0, right: 200, bottom: top + height, width: 200, height };
}

function container(id: string) {
  return {
    id,
    key: id,
    data: { current: {} },
    disabled: false,
    node: { current: document.createElement("div") },
    rect: { current: null },
  };
}

/// Sorting args: the dragged row travels down the list, and a non-sortable drop
/// target sits right where it is heading.
function sortArgs(activeId: string, draggedTop: number) {
  const rects = new Map([
    ["tag:alpha", rect(0, 40)],
    ["tag:beta", rect(40, 40)],
    ["tag:gamma", rect(80, 40)],
    ["create-channel", rect(120, 40)],
  ]);
  return {
    active: {
      id: activeId,
      data: { current: {} },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: rect(draggedTop, 40),
    droppableRects: rects,
    droppableContainers: [...rects.keys()].map(container),
    pointerCoordinates: { x: 12, y: draggedTop + 20 },
  };
}

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

  it("sorts collections by measured rects instead of reading the live DOM", () => {
    const elementsFromPoint = vi.fn(() => [row("tag:alpha")]);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: elementsFromPoint,
    });

    // Pointer inside beta's start-of-gesture slot (40..80).
    const [collision] = sidebarPointerWithin(sortArgs("tag:alpha", 55) as never);

    expect(collision?.id).toBe("tag:beta");
    // The point of the split: the sortable path must not consult the DOM, whose
    // rows move in response to the very answer being computed.
    expect(elementsFromPoint).not.toHaveBeenCalled();
  });

  it("puts the hole under the pointer, not under the grabbed row's centre", () => {
    mockElementsFromPoint([]);

    // The row was grabbed near its bottom edge: its rectangle's centre reaches
    // into gamma's slot while the pointer is still inside beta's. The hole must
    // follow the pointer — a target half a row away from the cursor is the
    // mismatch this check pins down.
    const args = sortArgs("tag:alpha", 70); // rect centre at 90 → gamma's slot
    args.pointerCoordinates = { x: 12, y: 62 }; // pointer inside beta's slot

    const [collision] = sidebarPointerWithin(args as never);

    expect(collision?.id).toBe("tag:beta");
  });

  it("keeps a collection sort inside the sortable list", () => {
    mockElementsFromPoint([]);

    // Pointer dead centre on the create-channel row (120..160), which is a drop
    // target but not a sortable one: it must not become the sort target, and
    // the nearest sortable slot wins instead of the target going blank.
    const [collision] = sidebarPointerWithin(sortArgs("tag:alpha", 120) as never);

    expect(collision?.id).toBe("tag:gamma");
  });

  it("prefers the row under the pointer over stale droppable rectangles", () => {
    const beta = row("tag:beta");
    mockElementsFromPoint([beta]);

    const [collision] = sidebarPointerWithin(collisionArgs("tag:beta"));

    expect(collision?.id).toBe("tag:beta");
    expect(collision?.data?.source).toBe("sidebar-pointer");
  });
});
