import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { DropZone } from "./DropZone";

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

const mocks = vi.hoisted(() => ({
  createBlock: vi.fn(),
  dragHandler: null as null | ((event: { payload: DragDropPayload }) => void),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async (handler: (event: { payload: DragDropPayload }) => void) => {
      mocks.dragHandler = handler;
      return vi.fn();
    }),
  }),
}));

vi.mock("@/lib/commands", () => ({
  createBlock: mocks.createBlock,
}));

function emitDrag(payload: DragDropPayload) {
  act(() => {
    mocks.dragHandler?.({ payload });
  });
}

describe("DropZone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dragHandler = null;
  });

  it("ignores non-file drag over events", async () => {
    render(<DropZone onBlocksCreated={vi.fn()} />);
    await waitFor(() => expect(mocks.dragHandler).not.toBeNull());

    emitDrag({ type: "over", position: { x: 10, y: 10 } });

    expect(screen.queryByText("Drop files to add")).not.toBeInTheDocument();
  });

  it("shows the overlay only after file enter and imports on drop", async () => {
    const onBlocksCreated = vi.fn();
    mocks.createBlock.mockResolvedValue(undefined);
    render(<DropZone currentTag="Inbox" onBlocksCreated={onBlocksCreated} />);
    await waitFor(() => expect(mocks.dragHandler).not.toBeNull());

    emitDrag({
      type: "enter",
      paths: ["/tmp/example.png"],
      position: { x: 10, y: 10 },
    });

    expect(screen.getByText("Drop files to add")).toBeInTheDocument();

    emitDrag({
      type: "drop",
      paths: ["/tmp/example.png"],
      position: { x: 10, y: 10 },
    });

    await waitFor(() => {
      expect(mocks.createBlock).toHaveBeenCalledWith({
        block_type: "image",
        title: "example",
        tags: ["Inbox"],
        file_path: "/tmp/example.png",
      });
    });
    expect(onBlocksCreated).toHaveBeenCalledOnce();
  });

  it("hides the file overlay on Escape", async () => {
    render(<DropZone onBlocksCreated={vi.fn()} />);
    await waitFor(() => expect(mocks.dragHandler).not.toBeNull());

    emitDrag({
      type: "enter",
      paths: ["/tmp/example.png"],
      position: { x: 10, y: 10 },
    });
    expect(screen.getByText("Drop files to add")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByText("Drop files to add")).not.toBeInTheDocument();
  });
});
