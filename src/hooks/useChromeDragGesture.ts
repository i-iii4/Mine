import { startWindowDrag } from "@/lib/commands";
import { usePressDragGesture } from "@/hooks/usePressDragGesture";

interface UseChromeDragGestureOptions {
  disabled?: boolean;
  thresholdPx?: number;
}

function dragWindow() {
  // The backend finds this tab's window: a tab page moved into another
  // window still names the first one itself (SPEC_TABS.md, В22, В23).
  void startWindowDrag().catch((error: unknown) => {
    console.error("Could not start dragging the window:", error);
  });
}

/** The window chrome's gesture: a press past the threshold drags the window
 *  of this page, a press without it stays a click (usePressDragGesture.ts). */
export function useChromeDragGesture({
  disabled = false,
  thresholdPx,
}: UseChromeDragGestureOptions = {}) {
  return usePressDragGesture({ disabled, thresholdPx, onDragStart: dragWindow });
}
