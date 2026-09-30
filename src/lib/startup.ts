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

let markCardsRendered: () => void = () => {};
const cardsRendered = new Promise<void>((resolve) => {
  markCardsRendered = resolve;
});

/// The feed has painted its first cards with their content, or an empty
/// feed has painted as empty: not skeletons waiting for word widths
/// (SPEC_AUDIT_FIXES.md, А8.2). Once per app session, like the startup
/// milestone it feeds.
export function reportCardsRendered(): void {
  markCardsRendered();
}

/// Resolves once the feed has painted its first real cards.
export function whenCardsRendered(): Promise<void> {
  return cardsRendered;
}
