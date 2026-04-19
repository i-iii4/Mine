import type {
  FeedPlaybackContainer,
  FeedPlaybackKind,
  FeedPlaybackProfile,
} from "@/types";

export interface NormalizedFeedPlaybackDescriptor {
  kind: FeedPlaybackKind;
  sourcePath: string;
  posterPreviewPath: string;
  width: number | null;
  height: number | null;
  container: FeedPlaybackContainer;
  profile: FeedPlaybackProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeFeedPlayback(
  raw: string | null | undefined,
): NormalizedFeedPlaybackDescriptor | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.kind !== "single_video") return null;

  const sourcePath = asString(parsed.source_path);
  const posterPreviewPath = asString(parsed.poster_preview_path);
  const container = parsed.container;
  const profile = parsed.profile === "heavy" ? "heavy" : "standard";

  if (!sourcePath || !posterPreviewPath) return null;
  if (container !== "mp4" && container !== "webm") return null;

  return {
    kind: "single_video",
    sourcePath,
    posterPreviewPath,
    width: asNullableNumber(parsed.width),
    height: asNullableNumber(parsed.height),
    container,
    profile,
  };
}
