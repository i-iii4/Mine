// The video tool behind X's restricted posts (`yt-dlp`, run by the helper):
// how its state and its failures read in the clipper (SPEC_CLIPPER.md, 3d,
// «Сбой утилиты видео», В3–В5). A failure of the tool never holds the
// clipper: the post is saved without its video, and one line says why.

/** Why the tool gave no video: the helper's `reason`. */
export type VideoToolFailureReason = "missing" | "blocked" | "timeout" | "failed";

export type VideoToolState =
  | { state: "ready"; version: string }
  | { state: "unavailable"; reason: VideoToolFailureReason; error?: string };

const REASONS: Record<VideoToolFailureReason, string> = {
  missing: "the video tool isn't installed",
  blocked: "macOS blocked the video tool",
  timeout: "the video tool didn't answer in time",
  failed: "the video tool failed",
};

function isReason(value: unknown): value is VideoToolFailureReason {
  return typeof value === "string" && value in REASONS;
}

/** The reason of a helper answer that is a tool failure, else `null`. */
export function videoToolFailureReason(response: unknown): VideoToolFailureReason | null {
  if (typeof response !== "object" || response === null) return null;
  const { ok, code, reason } = response as { ok?: unknown; code?: unknown; reason?: unknown };
  if (ok !== false || code !== "video_tool_failed") return null;
  return isReason(reason) ? reason : "failed";
}

/** The helper's self-check answer, or `null` when it gave none it knows:
 *  an older helper says `unknown action`, and the clipper then goes the old
 *  way, asking for the video. */
export function videoToolState(response: unknown): VideoToolState | null {
  if (typeof response !== "object" || response === null) return null;
  const { ok, video_tool: tool } = response as { ok?: unknown; video_tool?: unknown };
  if (ok !== true || typeof tool !== "object" || tool === null) return null;
  const { state, version, reason, error } = tool as Record<string, unknown>;
  if (state === "ready") return { state: "ready", version: typeof version === "string" ? version : "" };
  if (state === "unavailable") {
    return { state: "unavailable", reason: isReason(reason) ? reason : "failed", error: typeof error === "string" ? error : undefined };
  }
  return null;
}

/** The line under the preview (В4). */
export function videoNotice(reason: VideoToolFailureReason): string {
  return `Couldn't get the video: ${REASONS[reason]}. The text and pictures will be saved.`;
}

/** The answer the clipper gives itself instead of asking a tool it knows does
 *  not work: the same shape the helper sends for a failed run. */
export function knownVideoToolFailure(reason: VideoToolFailureReason) {
  return { ok: false as const, code: "video_tool_failed" as const, reason };
}
