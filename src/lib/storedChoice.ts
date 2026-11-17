// One choice among named values, kept between launches in its own
// localStorage key and heard by React (`useSyncExternalStore`). The open
// card's view and the Peek window's width keep theirs this way (cardView.ts).
// Every tab and window re-reads a choice on `settings-changed` (`reload`).

import { useSyncExternalStore } from "react";

/** The choice stored under `key`: one of `choices`, `fallback` while nothing
 *  valid is stored or the storage cannot be read. */
export function storedChoice<T extends string>(key: string, fallback: T, choices: readonly T[]) {
  const read = (): T => {
    try {
      const stored = window.localStorage.getItem(key);
      return choices.find((choice) => choice === stored) ?? fallback;
    } catch {
      return fallback;
    }
  };
  let current: T = typeof window === "undefined" ? fallback : read();
  const listeners = new Set<() => void>();
  const publish = (next: T) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const get = () => current;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    get,
    set(next: T) {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Unwritable storage (private mode, quota): the choice lasts this session.
      }
      publish(next);
    },
    /** Re-read storage: another tab or window chose (`settings-changed`). */
    reload: () => publish(read()),
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}
