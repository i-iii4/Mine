type FrameRequest = (callback: FrameRequestCallback) => number;
type FrameCancel = (handle: number) => void;

/// Run after React's pending commit has crossed a browser paint boundary.
/// Two frames avoid starting IO inside the same frame that publishes cards.
export function scheduleAfterNextPaint(
  callback: () => void,
  requestFrame: FrameRequest = window.requestAnimationFrame.bind(window),
  cancelFrame: FrameCancel = window.cancelAnimationFrame.bind(window),
): () => void {
  let cancelled = false;
  let secondFrame: number | null = null;
  const firstFrame = requestFrame(() => {
    if (cancelled) return;
    secondFrame = requestFrame(() => {
      if (!cancelled) callback();
    });
  });
  return () => {
    cancelled = true;
    cancelFrame(firstFrame);
    if (secondFrame !== null) cancelFrame(secondFrame);
  };
}
