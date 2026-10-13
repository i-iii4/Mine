import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { DropZone } from "./DropZone";
import { ActionFailureNoticeStack } from "./ActionFailureNotices";
import { clearActionFailures } from "@/lib/actionFailures";

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/** What the backend sends the tab its window shows (`tab-file-drag`). */
type TabFileDragPayload =
  | { kind: "enter"; paths: string[] }
  | { kind: "over" }
  | { kind: "drop"; paths: string[] }
  | { kind: "leave" };

const mocks = vi.hoisted(() => ({
  createBlock: vi.fn(),
  dragHandler: null as null | ((event: { payload: TabFileDragPayload }) => void),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

// Drops reach the page as the backend routes them to the tab its window
// shows, never through the page's own drag events (SPEC_TABS.md, В22).
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: mocks.listen,
    onDragDropEvent: () => {
      throw new Error("a page's own drag events are not heard");
    },
  }),
}));

vi.mock("@/lib/commands", () => ({
  createBlock: mocks.createBlock,
}));

/** A drag as the window saw it, delivered as the backend routes it. */
function emitDrag(payload: DragDropPayload) {
  const routed: TabFileDragPayload = payload.type === "enter" || payload.type === "drop"
    ? { kind: payload.type, paths: payload.paths }
    : { kind: payload.type };
  act(() => {
    mocks.dragHandler?.({ payload: routed });
  });
}

describe("DropZone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActionFailures();
    mocks.dragHandler = null;
    mocks.listen.mockImplementation(
      async (event: string, handler: (event: { payload: TabFileDragPayload }) => void) => {
        if (event === "tab-file-drag") mocks.dragHandler = handler;
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
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());

    view.rerender(<DropZone onBlocksCreated={vi.fn()} />);

    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it("unsubscribes when registration resolves after unmount", async () => {
    let finishRegistration!: (unlisten: () => void) => void;
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: TabFileDragPayload }) => void) => {
        mocks.dragHandler = handler;
        return new Promise<() => void>((resolve) => {
          finishRegistration = resolve;
        });
      },
    );
    const view = render(<DropZone onBlocksCreated={vi.fn()} />);
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());

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

  /// SPEC_DEEP_AUDIT.md, Е6.5: a file that cannot become an element does not
  /// stop the others, and the tab's notice names it and says the rest came
  /// in; before, the drop stopped at the first failure and said nothing of
  /// what was already created.
  it("keeps adding past a file that fails and names it in the tab's notice", async () => {
    mocks.createBlock.mockImplementation(async ({ file_path }: { file_path: string }) => {
      if (file_path.endsWith("b.png")) throw new Error("The disk is full.");
    });
    const onBlocksCreated = vi.fn();
    render(
      <>
        <DropZone onBlocksCreated={onBlocksCreated} />
        <ActionFailureNoticeStack />
      </>,
    );
    await waitFor(() => expect(mocks.dragHandler).not.toBeNull());

    emitDrag({ type: "drop", paths: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"], position: { x: 0, y: 0 } });

    expect(await screen.findByText("Could not create an element")).toBeInTheDocument();
    expect(mocks.createBlock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("2 other elements were created.")).toBeInTheDocument();
    expect(screen.getByText("“b.png”: The disk is full.")).toBeInTheDocument();
    expect(onBlocksCreated).toHaveBeenCalledOnce();
  });

  /// Е6.5: a drop that arrives while the last one is still being added
  /// waits its turn; before, it was thrown away.
  it("adds a second drop that arrives during the first", async () => {
    let finishFirst!: () => void;
    mocks.createBlock.mockImplementation(({ file_path }: { file_path: string }) => (
      file_path.endsWith("first.png")
        ? new Promise<void>((resolve) => { finishFirst = resolve; })
        : Promise.resolve()
    ));
    const onBlocksCreated = vi.fn();
    render(<DropZone onBlocksCreated={onBlocksCreated} />);
    await waitFor(() => expect(mocks.dragHandler).not.toBeNull());

    emitDrag({ type: "drop", paths: ["/tmp/first.png"], position: { x: 0, y: 0 } });
    await waitFor(() => expect(mocks.createBlock).toHaveBeenCalledOnce());
    emitDrag({ type: "drop", paths: ["/tmp/second.png"], position: { x: 0, y: 0 } });
    await act(async () => finishFirst());

    await waitFor(() => expect(mocks.createBlock).toHaveBeenCalledTimes(2));
    expect(mocks.createBlock).toHaveBeenLastCalledWith(expect.objectContaining({ file_path: "/tmp/second.png" }));
    await waitFor(() => expect(onBlocksCreated).toHaveBeenCalledTimes(2));
  });
});
