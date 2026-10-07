import { describe, expect, it } from "vitest";
import { knownVideoToolFailure, videoNotice, videoToolFailureReason, videoToolState } from "./videoTool";

// SPEC_CLIPPER.md, 3d, «Сбой утилиты видео», В3–В5.
describe("the video tool as the clipper reads it", () => {
  it("reads a failed run's reason and nothing else as a tool failure", () => {
    expect(videoToolFailureReason({ ok: false, code: "video_tool_failed", reason: "blocked", error: "x" })).toBe("blocked");
    expect(videoToolFailureReason({ ok: false, code: "video_tool_failed", reason: "something new" })).toBe("failed");
    expect(videoToolFailureReason({ ok: false, error: "failed to resolve Twitter media" })).toBeNull();
    expect(videoToolFailureReason({ ok: true, media: [] })).toBeNull();
    expect(videoToolFailureReason(undefined)).toBeNull();
    expect(videoToolFailureReason(knownVideoToolFailure("timeout"))).toBe("timeout");
  });

  it("reads the self-check, and an older helper's refusal as no answer", () => {
    expect(videoToolState({ ok: true, video_tool: { state: "ready", version: "2026.08.19" } }))
      .toEqual({ state: "ready", version: "2026.08.19" });
    expect(videoToolState({ ok: true, video_tool: { state: "unavailable", reason: "blocked", error: "macOS blocked the tool" } }))
      .toEqual({ state: "unavailable", reason: "blocked", error: "macOS blocked the tool" });
    expect(videoToolState({ ok: false, error: "unknown action: video_tool_status" })).toBeNull();
    expect(videoToolState({ ok: false, code: "native_timeout" })).toBeNull();
  });

  it("says why in one line and that the post is still saved", () => {
    expect(videoNotice("blocked")).toBe("Couldn't get the video: macOS blocked the video tool. The text and pictures will be saved.");
    expect(videoNotice("timeout")).toBe("Couldn't get the video: the video tool didn't answer in time. The text and pictures will be saved.");
    expect(videoNotice("missing")).toContain("isn't installed");
    expect(videoNotice("failed")).toContain("the video tool failed");
  });
});
