import type { FeedPreviewKind } from "@/types";
import { decodeLocalMarkdownUrl } from "@/lib/markdownWikilinks";

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

function fileNameOfLocalPath(value: string): string {
  const clean = decodeLocalMarkdownUrl(value).split("?")[0] ?? value;
  return clean.split(/[\\/]/).pop() ?? clean;
}

export function normalizeFeedPreviewManifest(
  raw: string | null | undefined,
): NormalizedFeedPreviewManifest | null {
  return normalizePreviewManifest(raw, true);
}

export function normalizeDetailPreviewManifest(
  raw: string | null | undefined,
): NormalizedFeedPreviewManifest | null {
  return normalizePreviewManifest(raw, false);
}

function normalizePreviewManifest(
  raw: string | null | undefined,
  requireDerivedTile: boolean,
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

          // A route-facing manifest is exposed only in preview_state=ready.
          // Missing paths therefore indicate corrupt/legacy data and must not
          // fall through to source media in the Grid process.
          const previewPath = asString(tile.preview_path);
          if (requireDerivedTile && !previewPath) return null;
          const isVideo = asBoolean(tile.is_video);
          const isVideoPoster = asBoolean(tile.is_video_poster);

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
  const normalizedSource = decodeLocalMarkdownUrl(sourcePath);
  const exact = manifest.tiles.find(
    (tile) => decodeLocalMarkdownUrl(tile.sourcePath) === normalizedSource,
  );
  if (exact) return exact;
  if (/[\\/]/.test(normalizedSource)) return null;

  const byBasename = manifest.tiles.filter(
    (tile) => fileNameOfLocalPath(tile.sourcePath) === normalizedSource,
  );
  return byBasename.length === 1 ? byBasename[0]! : null;
}
