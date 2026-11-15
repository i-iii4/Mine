// The page's commands over the image preview (SPEC_MEDIA_ASSET_ACTIONS.md,
// «Команды при открытом просмотре»; user's decision of 15.11.2026): which way
// the picture leaves for which input, and the order of the picture's going
// and the command's result.
import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImagePreviewHandle, ImagePreviewLeaving } from "@/components/ImagePreviewOverlay";
import {
  previewLeavingFor,
  useHeldPastImagePreview,
  useImagePreviewCommands,
  type RunPastImagePreview,
} from "./useImagePreviewCommands";

/** A viewer that records how it is asked to leave and goes when told. */
function fakeViewer() {
  const asked: { how: ImagePreviewLeaving; then: () => void }[] = [];
  const handle: ImagePreviewHandle = { leave: (how, then) => { asked.push({ how, then }); } };
  const gone = () => act(() => {
    for (const { then } of asked.splice(0)) then();
  });
  return { asked, handle, gone };
}

describe("previewLeavingFor", () => {
  it("takes the picture in the frame of a key, fades it for a press, keeps the scrim for the search", () => {
    expect(previewLeavingFor("key")).toBe("now");
    expect(previewLeavingFor("key", "stays")).toBe("now");
    expect(previewLeavingFor("pointer")).toBe("fade");
    expect(previewLeavingFor("pointer", "stays")).toBe("keep-scrim");
  });
});

describe("useImagePreviewCommands", () => {
  it("runs a command at once while no picture is open", () => {
    const { result } = renderHook(() => useImagePreviewCommands(false));
    const run = vi.fn();
    result.current.runPast("pointer", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("hands the command to the open viewer, which runs it once gone", () => {
    const viewer = fakeViewer();
    const { result } = renderHook(() => useImagePreviewCommands(true));
    result.current.handleRef.current = viewer.handle;
    const run = vi.fn();
    result.current.runPast("pointer", run, "stays");
    expect(viewer.asked.map(({ how }) => how)).toEqual(["keep-scrim"]);
    expect(run).not.toHaveBeenCalled();
    viewer.gone();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("useHeldPastImagePreview", () => {
  /** What the page shows of `value` in each render, as the sidebar's hook
   *  hears it. */
  function Shown({ value, open, byKey, runPast, seen }: {
    value: string;
    open: boolean;
    byKey: boolean;
    runPast: RunPastImagePreview;
    seen: string[];
  }) {
    const shown = useHeldPastImagePreview(value, open, () => byKey, runPast);
    seen.push(shown);
    return null;
  }

  it("shows a new value at once with no picture open", () => {
    const seen: string[] = [];
    const runPast = vi.fn<RunPastImagePreview>((_input, run) => run());
    const { rerender } = render(<Shown value="open" open={false} byKey={false} runPast={runPast} seen={seen} />);
    rerender(<Shown value="collapsed" open={false} byKey={false} runPast={runPast} seen={seen} />);
    expect(seen.at(-1)).toBe("collapsed");
    expect(seen).not.toContain("held");
    expect(runPast).not.toHaveBeenCalled();
  });

  it("holds a value a press sent until the picture has faded, never showing it early", () => {
    const viewer = fakeViewer();
    const runPast: RunPastImagePreview = (input, run) => viewer.handle.leave(previewLeavingFor(input), run);
    const seen: string[] = [];
    const { rerender } = render(<Shown value="open" open byKey={false} runPast={runPast} seen={seen} />);
    rerender(<Shown value="collapsed" open byKey={false} runPast={runPast} seen={seen} />);
    expect(viewer.asked.map(({ how }) => how)).toEqual(["fade"]);
    expect(seen.every((value) => value === "open")).toBe(true);
    viewer.gone();
    expect(seen.at(-1)).toBe("collapsed");
  });

  it("shows a value a key sent at once, the picture going in the same frame", () => {
    const viewer = fakeViewer();
    const runPast: RunPastImagePreview = (input, run) => viewer.handle.leave(previewLeavingFor(input), run);
    const seen: string[] = [];
    const { rerender } = render(<Shown value="open" open byKey runPast={runPast} seen={seen} />);
    rerender(<Shown value="collapsed" open byKey runPast={runPast} seen={seen} />);
    // The render that hears the value shows it; the viewer is told to go now.
    expect(seen.filter((value) => value === "collapsed").length).toBeGreaterThan(0);
    expect(seen.indexOf("collapsed")).toBe(1);
    expect(viewer.asked.map(({ how }) => how)).toEqual(["now"]);
  });

  it("shows the last of several values that came during one fade", () => {
    const viewer = fakeViewer();
    const runPast: RunPastImagePreview = (input, run) => viewer.handle.leave(previewLeavingFor(input), run);
    const seen: string[] = [];
    const { rerender } = render(<Shown value="a" open byKey={false} runPast={runPast} seen={seen} />);
    rerender(<Shown value="b" open byKey={false} runPast={runPast} seen={seen} />);
    rerender(<Shown value="c" open byKey={false} runPast={runPast} seen={seen} />);
    expect(seen.at(-1)).toBe("a");
    viewer.gone();
    expect(seen.at(-1)).toBe("c");
  });
});
