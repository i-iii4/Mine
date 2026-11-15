import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeStep, MergeTiming } from "@/types";

const log = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: log.invoke }));

import { logMergeTiming, mergeTimingLine } from "./mergeTiming";

/** Every step the command times, in its order (merge_timing.rs, `MergeStep::ALL`). */
const STEPS: MergeStep[] = [
  "flush_edits",
  "space_lock",
  "layout",
  "index_up_to_files",
  "read_sources",
  "merged_name",
  "scan_space_files",
  "compose",
  "reference_writes",
  "suppress_paths",
  "stage",
  "commit_writes",
  "commit_trash",
  "commit_index",
  "commit_finalize",
  "merged_preview",
  "reference_previews",
  "source_pictures",
  "read_merged",
  "announce",
];

const timing: MergeTiming = {
  cards: 3,
  pictures: 5,
  steps: STEPS.map((step, index) => ({ step, ms: index + 0.25 })),
};

const page = { commandMs: 400, reloadMs: 120.04, paintMs: 16.66, totalMs: 536.7 };

beforeEach(() => log.invoke.mockClear());

/// SPEC_CARD_MERGE.md, «Замер слияния».
describe("the log line of a merge", () => {
  it("names the size, the page's parts and every step of the command, in order", () => {
    const line = mergeTimingLine(timing, page, 3);
    expect(line.startsWith("merge timing: done cards=3 pictures=5 total_ms=536.7 command_ms=400.0")).toBe(true);
    // 0.25 + 1.25 + … + 19.25 = 195 ms in the command, 205 ms on the way.
    expect(line).toContain("transport_ms=205.0 reload_ms=120.0 paint_ms=16.7 steps:");
    const named = line.split("steps: ")[1]?.split(" ").map((entry) => entry.split("=")[0]);
    expect(named).toEqual(STEPS);
    expect(line).toContain("index_up_to_files=3.3");
  });

  it("knows every step the command times, in the command's order", () => {
    const rust = readFileSync("src-tauri/src/commands/merge_timing.rs", "utf8");
    const all = /pub const ALL: \[MergeStep; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1] ?? "";
    const names = [...all.matchAll(/MergeStep::(\w+)/g)].map(([, name]) =>
      (name ?? "").replace(/[A-Z]/g, (letter, at: number) => `${at === 0 ? "" : "_"}${letter.toLowerCase()}`),
    );
    expect(names).toEqual(STEPS);
  });

  it("says a failed merge failed, with the page's parts only", () => {
    expect(mergeTimingLine(null, page, 4)).toBe(
      "merge timing: failed cards=4 pictures=unknown total_ms=536.7 command_ms=400.0 reload_ms=120.0 paint_ms=16.7",
    );
  });

  it("writes one line to Mine.log at info, numbers and names only", () => {
    logMergeTiming(timing, page, 3);
    expect(log.invoke).toHaveBeenCalledTimes(1);
    expect(log.invoke).toHaveBeenCalledWith("plugin:log|log", {
      level: 3,
      message: mergeTimingLine(timing, page, 3),
      location: "page",
    });
    expect(mergeTimingLine(timing, page, 3)).toMatch(/^[a-z_:= .0-9]+$/);
  });
});
