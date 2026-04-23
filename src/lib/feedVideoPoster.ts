import type { CardLayoutMediaItem } from "@/lib/cardLayout";
import type { NormalizedFeedPreviewManifest } from "@/lib/feedPreview";
import type { NormalizedFeedPlaybackDescriptor } from "@/lib/feedPlayback";
import { previewAssetUrl, thumbnailUrl } from "@/lib/assets";

export function buildFeedVideoPosterCandidates({
  slug,
  thumbsRootPath,
  previewManifest,
  playback,
  primaryMedia,
}: {
  slug: string;
  thumbsRootPath: string;
  previewManifest: NormalizedFeedPreviewManifest | null;
  playback: NormalizedFeedPlaybackDescriptor | null;
  primaryMedia?: Pick<CardLayoutMediaItem, "previewPath"> | null;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (url: string | null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push(url);
  };

  push(
    playback?.posterPreviewPath
      ? previewAssetUrl(thumbsRootPath, playback.posterPreviewPath)
      : null,
  );
  push(
    previewManifest?.primaryPreviewPath
      ? previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath)
      : null,
  );
  push(
    primaryMedia?.previewPath
      ? previewAssetUrl(thumbsRootPath, primaryMedia.previewPath)
      : null,
  );
  push(thumbnailUrl(thumbsRootPath, slug));

  return candidates;
}
