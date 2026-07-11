import type { LightBlock } from "@/types";
import { previewAssetUrl } from "@/lib/assets";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";
import { normalizeFeedPreviewManifest } from "@/lib/feedPreview";

export type FeedMediaCandidateRole =
  | "primary-preview"
  | "tile-preview"
  | "poster-preview";

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

interface FeedMediaCandidateCacheEntry {
  previewManifest: string | null;
  feedPlayback: string | null;
  thumbsRootPath: string;
  candidates: readonly FeedMediaCandidate[];
}

// Per-block memoization of derived preload candidates. The feed preloader
// recomputes its preload window on every rAF-coalesced scroll frame (up to
// ~120/s), and for each of the dozens of blocks in that window it calls this
// function, which parses `preview_manifest` and `feed_playback` JSON. Without
// caching that is hundreds of JSON.parse calls per scrolled second — pure GC
// pressure. The WeakMap keys on block identity, so it never leaks when the
// blocks array is replaced. Correctness never relies on block identity being
// stable: the stored fields are the full set of inputs to the derivation, so a
// reused block object with mutated content still recomputes on mismatch.
const candidateCache = new WeakMap<LightBlock, FeedMediaCandidateCacheEntry>();

export function feedMediaCandidatesForBlock({
  block,
  thumbsRootPath,
}: {
  block: LightBlock;
  thumbsRootPath: string;
}): readonly FeedMediaCandidate[] {
  const cached = candidateCache.get(block);
  if (
    cached &&
    cached.previewManifest === block.preview_manifest &&
    cached.feedPlayback === block.feed_playback &&
    cached.thumbsRootPath === thumbsRootPath
  ) {
    return cached.candidates;
  }

  const candidates = computeFeedMediaCandidates(block, thumbsRootPath);
  candidateCache.set(block, {
    previewManifest: block.preview_manifest,
    feedPlayback: block.feed_playback,
    thumbsRootPath,
    candidates,
  });
  return candidates;
}

function computeFeedMediaCandidates(
  block: LightBlock,
  thumbsRootPath: string,
): readonly FeedMediaCandidate[] {
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

  return candidates;
}
