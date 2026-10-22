import { useSyncExternalStore } from "react";
import { currentChromeRowHeight, subscribeToChromeRowHeight } from "@/lib/chromeHeight";

/** The page's top rows' content height, following the logo menu's choice. */
export function useChromeRowHeight(): number {
  return useSyncExternalStore(subscribeToChromeRowHeight, currentChromeRowHeight, currentChromeRowHeight);
}
