// TRIAL (SPEC_CARD_PEEK.md, О12): the open card's window moves without the
// card's own work landing in the middle of the motion. While the window
// moves, what the open card learns late (its whole file, its editor's
// session, its pictures' own sizes, its associations) waits and lands once
// the window rests; before the window starts, the window waits a moment for
// that work, so the card it shows is the one it ends with. Outside the window
// (the full page, a test) the gate lets everything through at once.

import { createContext, useContext } from "react";

export interface DetailMotionGate {
  /** Applies `update` now, or once the window carrying the card rests. */
  defer(update: () => void): void;
  /** Tells the window about work the card waits for, so it can wait for it
   *  before it starts; returns the same promise. */
  track<T>(work: Promise<T>): Promise<T>;
}

/** No window: everything lands at once and nothing waits. */
export const IMMEDIATE_DETAIL_GATE: DetailMotionGate = {
  defer: (update) => update(),
  track: (work) => work,
};

export const DetailMotionGateContext = createContext<DetailMotionGate>(IMMEDIATE_DETAIL_GATE);

/** The gate of the window the open card stands in, if any. */
export function useDetailMotionGate(): DetailMotionGate {
  return useContext(DetailMotionGateContext);
}
