import type { FeedPreviewKind } from "@/types";

export interface NormalizedFeedPreviewTile {
  sourcePath: string;
  previewPath: string | null;
  width: number | null;
  height: number | null;
  isVideo: boolean;
  isVideoPoster: boolean;
}

export interface NormalizedFeedPreviewManifest {
  kind: FeedPreviewKind;
  primaryPreviewPath: string | null;
  width: number | null;
  height: number | null;
  tiles: NormalizedFeedPreviewTile[];
  overflowCount: number;
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

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isRemotePath(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function deriveTilePreviewPath(sourcePath: string): string | null {
  if (isRemotePath(sourcePath)) return null;
  const clean = sourcePath.split("?")[0] ?? sourcePath;
  const fileName = clean.split("/").pop();
  if (!fileName) return null;
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return stem ? `${stem}.jpg` : null;
}

export function normalizeFeedPreviewManifest(
  raw: string | null | undefined,
): NormalizedFeedPreviewManifest | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const kind = (() => {
    const value = parsed.kind;
    switch (value) {
      case "text":
      case "image":
      case "video_poster":
      case "composite":
        return value;
      default:
        return "text" as const;
    }
  })();

  const primaryPreviewPath = asString(parsed.primary_preview_path);
  const width = asNullableNumber(parsed.width);
  const height = asNullableNumber(parsed.height);
  const overflowCount =
    typeof parsed.overflow_count === "number" && parsed.overflow_count > 0
      ? parsed.overflow_count
      : 0;

  const tiles = Array.isArray(parsed.tiles)
    ? parsed.tiles
        .map((tile): NormalizedFeedPreviewTile | null => {
          if (!isRecord(tile)) return null;
          const sourcePath = asString(tile.source_path) ?? asString(tile.src);
          if (!sourcePath) return null;

          let previewPath = asString(tile.preview_path);
          const isVideo = asBoolean(tile.is_video);
          const isVideoPoster = asBoolean(tile.is_video_poster);

          if (!previewPath) {
            previewPath = deriveTilePreviewPath(sourcePath);
          }
          if (!previewPath && isVideoPoster) {
            previewPath = primaryPreviewPath;
          }

          return {
            sourcePath,
            previewPath,
            width: asNullableNumber(tile.width),
            height: asNullableNumber(tile.height),
            isVideo,
            isVideoPoster,
          };
        })
        .filter((tile): tile is NormalizedFeedPreviewTile => tile !== null)
    : [];

  return {
    kind,
    primaryPreviewPath,
    width,
    height,
    tiles,
    overflowCount,
  };
}

export function findPreviewTileForSource(
  manifest: NormalizedFeedPreviewManifest | null,
  sourcePath: string,
): NormalizedFeedPreviewTile | null {
  if (!manifest) return null;
  return manifest.tiles.find((tile) => tile.sourcePath === sourcePath) ?? null;
}
