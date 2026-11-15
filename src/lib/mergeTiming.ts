// The measurement of one card merge (SPEC_CARD_MERGE.md, «Замер слияния»):
// one line in `Mine.log` per merge, from the press on Merge to the feed drawn
// again. The command times its own steps and hands them back; the page adds
// the wait for the answer, the feed's reading and the frame after it. Numbers
// and step names only: no path, no title, no text.

import type { MergeTiming } from "@/types";
import { logInfo } from "./appLog";

/** What the page measured around the command, in milliseconds. */
export interface MergePageTiming {
  /** From the press to the command's answer. */
  commandMs: number;
  /** The feed, collections and sidebar previews read again. */
  reloadMs: number;
  /** From the read to the next frame. */
  paintMs: number;
  /** From the press to that frame. */
  totalMs: number;
}

const ms = (value: number) => (Math.round(value * 10) / 10).toFixed(1);

/** The log line of one merge. `backend` is the command's timing, `null`
 *  when the command failed; `cards` then counts the cards asked for. */
export function mergeTimingLine(backend: MergeTiming | null, page: MergePageTiming, cards: number): string {
  const head = [
    `merge timing: ${backend === null ? "failed" : "done"}`,
    `cards=${backend?.cards ?? cards}`,
    `pictures=${backend === null ? "unknown" : backend.pictures}`,
    `total_ms=${ms(page.totalMs)}`,
    `command_ms=${ms(page.commandMs)}`,
  ];
  if (backend === null) {
    return [...head, `reload_ms=${ms(page.reloadMs)}`, `paint_ms=${ms(page.paintMs)}`].join(" ");
  }
  const inCommand = backend.steps.reduce((sum, step) => sum + step.ms, 0);
  return [
    ...head,
    // The answer's way between the page and the command, and its queue.
    `transport_ms=${ms(Math.max(0, page.commandMs - inCommand))}`,
    `reload_ms=${ms(page.reloadMs)}`,
    `paint_ms=${ms(page.paintMs)}`,
    "steps:",
    ...backend.steps.map((step) => `${step.step}=${ms(step.ms)}`),
  ].join(" ");
}

/** Write the line of one merge to `Mine.log`. */
export function logMergeTiming(backend: MergeTiming | null, page: MergePageTiming, cards: number): void {
  logInfo(mergeTimingLine(backend, page, cards));
}
