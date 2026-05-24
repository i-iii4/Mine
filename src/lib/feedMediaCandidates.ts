import type { LightBlock } from "@/types";
import { previewAssetUrl, thumbnailUrl } from "@/lib/assets";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";
import { normalizeFeedPreviewManifest } from "@/lib/feedPreview";

export type FeedMediaCandidateRole =
  | "primary-preview"
  | "tile-preview"
  | "poster-preview"
  | "thumbnail";

export interface FeedMediaCandidate {
  url: string;
  role: FeedMediaCandidateRole;
  source: "derived";
  width: number | null;
  height: number | null;
}

function pushUniqueCandidate(
  candidates: FeedMediaCandidate[],
  seen: Set<string>,
  candidate: FeedMediaCandidate | null,
): void {
  if (!candidate || seen.has(candidate.url)) return;
  seen.add(candidate.url);
  candidates.push(candidate);
}

export function feedMediaCandidatesForBlock({
  block,
  thumbsRootPath,
}: {
  block: LightBlock;
  thumbsRootPath: string;
}): FeedMediaCandidate[] {
  const candidates: FeedMediaCandidate[] = [];
  const seen = new Set<string>();
  const previewManifest = normalizeFeedPreviewManifest(block.preview_manifest);
  const playback = normalizeFeedPlayback(block.feed_playback);

  pushUniqueCandidate(
    candidates,
    seen,
    playback
      ? {
          url: previewAssetUrl(thumbsRootPath, playback.posterPreviewPath),
          role: "poster-preview",
          source: "derived",
          width: playback.width,
          height: playback.height,
        }
      : null,
  );

  pushUniqueCandidate(
    candidates,
    seen,
    previewManifest?.primaryPreviewPath
      ? {
          url: previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath),
          role: "primary-preview",
          source: "derived",
          width: previewManifest.width,
          height: previewManifest.height,
        }
      : null,
  );

  if (previewManifest) {
    for (const tile of previewManifest.tiles) {
      pushUniqueCandidate(
        candidates,
        seen,
        tile.previewPath
          ? {
              url: previewAssetUrl(thumbsRootPath, tile.previewPath),
              role: "tile-preview",
              source: "derived",
              width: tile.width,
              height: tile.height,
            }
          : null,
      );
    }
  }

  pushUniqueCandidate(candidates, seen, {
    url: thumbnailUrl(thumbsRootPath, block.slug),
    role: "thumbnail",
    source: "derived",
    width: block.width,
    height: block.height,
  });

  return candidates;
}
