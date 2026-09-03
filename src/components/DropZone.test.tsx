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
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: mocks.onDragDropEvent,
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
    mocks.onDragDropEvent.mockImplementation(
      async (handler: (event: { payload: DragDropPayload }) => void) => {
        mocks.dragHandler = handler;
        return mocks.unlisten;
      },
    );
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
        url: null,
        tags: ["Inbox"],
        file_path: "/tmp/example.png",
      });
    });
    expect(onBlocksCreated).toHaveBeenCalledOnce();
  });

  it("imports a duplicated native path only once", async () => {
    mocks.createBlock.mockResolvedValue(undefined);
    render(<DropZone onBlocksCreated={vi.fn()} />);
    await waitFor(() => expect(mocks.dragHandler).not.toBeNull());

    emitDrag({
      type: "drop",
      paths: ["/tmp/example.png", "/tmp/example.png", "/tmp/example.png"],
      position: { x: 10, y: 10 },
    });

    await waitFor(() => expect(mocks.createBlock).toHaveBeenCalledOnce());
  });

  it("does not resubscribe when its completion callback changes", async () => {
    const view = render(<DropZone onBlocksCreated={vi.fn()} />);
    await waitFor(() => expect(mocks.onDragDropEvent).toHaveBeenCalledOnce());

    view.rerender(<DropZone onBlocksCreated={vi.fn()} />);

    expect(mocks.onDragDropEvent).toHaveBeenCalledOnce();
  });

  it("unsubscribes when registration resolves after unmount", async () => {
    let finishRegistration!: (unlisten: () => void) => void;
    mocks.onDragDropEvent.mockImplementation(
      (handler: (event: { payload: DragDropPayload }) => void) => {
        mocks.dragHandler = handler;
        return new Promise<() => void>((resolve) => {
          finishRegistration = resolve;
        });
      },
    );
    const view = render(<DropZone onBlocksCreated={vi.fn()} />);
    await waitFor(() => expect(mocks.onDragDropEvent).toHaveBeenCalledOnce());

    view.unmount();
    finishRegistration(mocks.unlisten);

    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledOnce());
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
