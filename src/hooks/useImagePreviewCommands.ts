// The page's commands over the image preview (SPEC_MEDIA_ASSET_ACTIONS.md,
// «Команды при открытом просмотре»; user's decision of 15.11.2026). A command
// whose result shows on this page (the sidebar, the search, the collections'
// search, a new collection) first takes the picture away and then runs: a
// key or a native menu item takes it in the frame of the command and the
// command runs at once (SPEC_MOTION_LEVELS.md, Р4); a press of a button
// fades the picture over Поверхность's leaving, and only then does the
// command's own motion start, so that one thing at a time answers the press.
// The search takes the scrim over as it stands. A command whose result shows
// elsewhere (another window, another tab) leaves the picture alone.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ImagePreviewHandle, ImagePreviewLeaving } from "@/components/ImagePreviewOverlay";

/** What gave the command: a key, a native menu item, or a press of a button. */
export type PreviewCommandInput = "key" | "pointer";

/** Where the scrim goes: with the picture, or over to the search. */
export type PreviewCommandScrim = "leaves" | "stays";

/** How the viewer leaves for a command given by `input`. */
export function previewLeavingFor(input: PreviewCommandInput, scrim: PreviewCommandScrim = "leaves"): ImagePreviewLeaving {
  if (input === "key") return "now";
  return scrim === "stays" ? "keep-scrim" : "fade";
}

/** Runs a command past the open image preview. */
export type RunPastImagePreview = (input: PreviewCommandInput, run: () => void, scrim?: PreviewCommandScrim) => void;

export interface ImagePreviewCommands {
  /** The viewer's handle: `ImagePreviewOverlay`'s `ref`. */
  handleRef: RefObject<ImagePreviewHandle | null>;
  /** `run` once the viewer is gone; at once with no viewer open. */
  runPast: RunPastImagePreview;
}

/** The commands over the viewer that `open` says is on the page. */
export function useImagePreviewCommands(open: boolean): ImagePreviewCommands {
  const handleRef = useRef<ImagePreviewHandle | null>(null);
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  const runPast = useCallback<RunPastImagePreview>((input, run, scrim = "leaves") => {
    const handle = handleRef.current;
    if (!openRef.current || !handle) {
      run();
      return;
    }
    handle.leave(previewLeavingFor(input, scrim), run);
  }, []);
  return { handleRef, runPast };
}

/**
 * `value` as the page shows it: a new value that comes while the viewer is
 * open waits for the picture to go. By a key (`byKey()` true when the value
 * changes) the picture goes in this frame and the value stands at once; by
 * the pointer the page shows the former value until the picture has faded
 * out. The sidebar's layout from the backend comes this way (SPEC_TABS.md,
 * В56): it is the one command of the page that arrives as a new value
 * rather than as a call.
 */
export function useHeldPastImagePreview<T>(
  value: T,
  previewOpen: boolean,
  byKey: () => boolean,
  runPast: RunPastImagePreview,
): T {
  const [held, setHeld] = useState<{ seen: T; shown: T }>(() => ({ seen: value, shown: value }));
  let shown = held.shown;
  if (held.seen !== value) {
    // Decided in the render that sees the value, so no frame shows it early.
    const waits = previewOpen && !byKey();
    shown = waits ? held.shown : value;
    setHeld({ seen: value, shown });
  }
  const seen = held.seen;
  const byKeyRef = useRef(byKey);
  useLayoutEffect(() => {
    byKeyRef.current = byKey;
  }, [byKey]);
  const previewOpenRef = useRef(previewOpen);
  useLayoutEffect(() => {
    previewOpenRef.current = previewOpen;
  }, [previewOpen]);
  const firstRef = useRef(true);
  useLayoutEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    if (!previewOpenRef.current) return;
    runPast(byKeyRef.current() ? "key" : "pointer", () => {
      setHeld((current) => (current.shown === current.seen ? current : { ...current, shown: current.seen }));
    });
  }, [runPast, seen]);
  return shown;
}
