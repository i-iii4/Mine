import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, previewAssetUrl } from "@/lib/assets";
import type { NormalizedFeedPlaybackDescriptor } from "@/lib/feedPlayback";
import { FeedVideoPoster } from "./FeedVideoPoster";
import { PlayBadge } from "./PlayBadge";

export const FEED_VIDEO_DIRECT_TIMEOUT_MS = 1200;
export const FEED_VIDEO_BLOB_TIMEOUT_MS = 1800;
// Ceiling on the blob fetch itself (network + body read), distinct from
// FEED_VIDEO_BLOB_TIMEOUT_MS which budgets decode + play once the bytes are in
// hand. A dataless iCloud file that never materializes (or a lost network) would
// otherwise leave a hung fetch holding phase="loading_blob" forever: the fetch
// is never aborted and the retry effect only fires from failed_poster_only. This
// budget is generous — a large but valid clip can take several seconds — so it
// only trips on a genuinely stuck request.
export const FEED_VIDEO_FETCH_TIMEOUT_MS = 20000;
// A card that degraded to poster-only is not necessarily broken: iCloud
// dataless files can take several seconds to materialize, so a valid clip can
// miss both the direct and blob budgets on first mount. While the surface stays
// mounted and playback-eligible it retries autoplay from scratch a bounded
// number of times before giving up until the next allowPlayback cycle.
export const FEED_VIDEO_RETRY_DELAY_MS = 4000;
export const FEED_VIDEO_MAX_RETRIES = 2;

export type FeedVideoPhase =
  | "poster"
  | "loading_direct"
  | "playing_direct"
  | "loading_blob"
  | "playing_blob"
  | "failed_poster_only";

interface FeedVideoSurfaceProps {
  playback: NormalizedFeedPlaybackDescriptor;
  allowPlayback: boolean;
  vaultPath: string;
  thumbsRootPath: string;
  posterCandidates?: string[];
  className?: string;
}

export function FeedVideoSurface({
  playback,
  allowPlayback,
  vaultPath,
  thumbsRootPath,
  posterCandidates,
  className,
}: FeedVideoSurfaceProps) {
  const [phase, setPhase] = useState<FeedVideoPhase>("poster");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const directVideoRef = useRef<HTMLVideoElement | null>(null);
  const blobVideoRef = useRef<HTMLVideoElement | null>(null);
  const retriesRef = useRef(0);

  const directSrc = useMemo(
    () => mediaUrl(vaultPath, playback.sourcePath),
    [playback.sourcePath, vaultPath],
  );
  const posterSrc = useMemo(
    () => previewAssetUrl(thumbsRootPath, playback.posterPreviewPath),
    [playback.posterPreviewPath, thumbsRootPath],
  );
  const resolvedPosterCandidates = useMemo(
    () => (posterCandidates && posterCandidates.length > 0 ? posterCandidates : [posterSrc]),
    [posterCandidates, posterSrc],
  );
  const usesBlobTimeout = playback.profile === "standard";
  // The blob fallback buffers the whole file in memory. `standard` clips are
  // size-capped so that is bounded, but `heavy` clips have no upper size limit
  // (the backend guarantees they stream from disk) and the grid keeps up to two
  // heavy clips active — two unbounded in-memory buffers in the worst case. So
  // `heavy` is strictly direct-only: any direct failure degrades to poster-only
  // immediately, and recovery goes through the memory-free retry instead.
  const directFailurePhase =
    playback.profile === "heavy" ? ("failed_poster_only" as const) : ("loading_blob" as const);
  useEffect(() => {
    setPhase(allowPlayback ? "loading_direct" : "poster");
    setBlobUrl(null);
    retriesRef.current = 0;
  }, [allowPlayback, directSrc, posterSrc]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  const attemptPlay = useCallback(
    (
      video: HTMLVideoElement | null,
      fromPhase: "loading_direct" | "loading_blob",
      toPlayingPhase: "playing_direct" | "playing_blob",
      toFailurePhase: "loading_blob" | "failed_poster_only",
    ) => {
      if (!video) return;
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;

      let playResult: Promise<void> | undefined;
      try {
        playResult = video.play();
      } catch {
        setPhase((current) => (current === fromPhase ? toFailurePhase : current));
        return;
      }

      if (!playResult || typeof playResult.then !== "function") {
        setPhase((current) => (current === fromPhase ? toPlayingPhase : current));
        return;
      }

      void playResult
        .then(() => {
          setPhase((current) => (current === fromPhase ? toPlayingPhase : current));
        })
        .catch(() => {
          setPhase((current) => (current === fromPhase ? toFailurePhase : current));
        });
    },
    [],
  );

  useEffect(() => {
    if (phase !== "loading_direct") return;
    attemptPlay(
      directVideoRef.current,
      "loading_direct",
      "playing_direct",
      directFailurePhase,
    );
    if (playback.profile === "heavy") {
      return;
    }
    const timer = window.setTimeout(() => {
      setPhase((current) =>
        current === "loading_direct" ? directFailurePhase : current,
      );
    }, FEED_VIDEO_DIRECT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attemptPlay, directFailurePhase, phase, playback.profile]);

  useEffect(() => {
    if (phase !== "loading_blob") return;
    attemptPlay(
      blobVideoRef.current,
      "loading_blob",
      "playing_blob",
      "failed_poster_only",
    );

    const controller = new AbortController();
    let cancelled = false;
    // The blob timeout only covers decode + play, so it must not start until the
    // bytes are in hand — otherwise a large but valid clip would be failed
    // mid-download by a budget meant for decoding. The separate fetch timeout
    // below guards the fetch stage itself so a hung request cannot pin
    // phase="loading_blob" indefinitely.
    let blobTimeoutId: number | null = null;

    // Abort a fetch that never delivers bytes and degrade to poster-only, where
    // the existing retry can pick recovery back up. The mock/real fetch may not
    // reject on abort, so transition the phase directly rather than relying on
    // the catch below.
    const fetchTimeoutId = window.setTimeout(() => {
      controller.abort();
      setPhase((current) =>
        current === "loading_blob" ? "failed_poster_only" : current,
      );
    }, FEED_VIDEO_FETCH_TIMEOUT_MS);

    void fetch(directSrc, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        window.clearTimeout(fetchTimeoutId);
        if (usesBlobTimeout) {
          blobTimeoutId = window.setTimeout(() => {
            setPhase((current) =>
              current === "loading_blob" ? "failed_poster_only" : current,
            );
          }, FEED_VIDEO_BLOB_TIMEOUT_MS);
        }
        const nextUrl = URL.createObjectURL(blob);
        setBlobUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return nextUrl;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPhase((current) =>
            current === "loading_blob" ? "failed_poster_only" : current,
          );
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(fetchTimeoutId);
      if (blobTimeoutId !== null) window.clearTimeout(blobTimeoutId);
    };
  }, [attemptPlay, directSrc, phase, usesBlobTimeout]);

  // Non-terminal failed_poster_only: while mounted and still playback-eligible,
  // reattempt autoplay from loading_direct after a delay — the source file may
  // have finished materializing. Bounded to FEED_VIDEO_MAX_RETRIES per mount;
  // the retriesRef is reset by the allowPlayback/src reset effect above.
  useEffect(() => {
    if (phase !== "failed_poster_only") return;
    if (!allowPlayback) return;
    if (retriesRef.current >= FEED_VIDEO_MAX_RETRIES) return;
    const timer = window.setTimeout(() => {
      retriesRef.current += 1;
      setBlobUrl(null);
      setPhase("loading_direct");
    }, FEED_VIDEO_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [allowPlayback, phase]);

  const posterVisible =
    phase !== "playing_direct" && phase !== "playing_blob";
  const directVideoVisible = phase === "playing_direct";
  const blobVideoVisible = phase === "playing_blob";

  return (
    <div
      data-feed-video-surface="true"
      data-feed-video-phase={phase}
      className="relative h-full w-full"
    >
      <FeedVideoPoster
        candidateUrls={resolvedPosterCandidates}
        alt=""
        className={`${className ?? "h-full w-full object-cover"} absolute inset-0 transition-opacity ${
          posterVisible ? "z-10 opacity-100" : "z-0 opacity-0"
        }`}
        loading="eager"
      />

      {(phase === "loading_direct" || phase === "playing_direct") && (
        <video
          ref={directVideoRef}
          src={directSrc}
          className={`${className ?? "h-full w-full object-cover"} absolute inset-0 z-0 transition-opacity ${
            directVideoVisible ? "opacity-100" : "opacity-0"
          }`}
          autoPlay
          loop
          muted
          draggable={false}
          playsInline
          preload="metadata"
          onLoadedData={() => {
            attemptPlay(
              directVideoRef.current,
              "loading_direct",
              "playing_direct",
              directFailurePhase,
            );
          }}
          onCanPlay={() => {
            attemptPlay(
              directVideoRef.current,
              "loading_direct",
              "playing_direct",
              directFailurePhase,
            );
          }}
          onPlaying={() => {
            setPhase((current) =>
              current === "loading_direct" ? "playing_direct" : current,
            );
          }}
          onError={() => {
            setPhase((current) => {
              if (current === "loading_direct" || current === "playing_direct") {
                return directFailurePhase;
              }
              return current;
            });
          }}
        />
      )}

      {blobUrl && (phase === "loading_blob" || phase === "playing_blob") && (
        <video
          ref={blobVideoRef}
          src={blobUrl}
          className={`${className ?? "h-full w-full object-cover"} absolute inset-0 z-0 transition-opacity ${
            blobVideoVisible ? "opacity-100" : "opacity-0"
          }`}
          autoPlay
          loop
          muted
          draggable={false}
          playsInline
          preload="metadata"
          onLoadedData={() => {
            attemptPlay(
              blobVideoRef.current,
              "loading_blob",
              "playing_blob",
              "failed_poster_only",
            );
          }}
          onCanPlay={() => {
            attemptPlay(
              blobVideoRef.current,
              "loading_blob",
              "playing_blob",
              "failed_poster_only",
            );
          }}
          onPlaying={() => {
            setPhase((current) =>
              current === "loading_blob" ? "playing_blob" : current,
            );
          }}
          onError={() => {
            setPhase((current) =>
              current === "loading_blob" || current === "playing_blob"
                ? "failed_poster_only"
                : current,
            );
          }}
        />
      )}

      {/* Poster-visible phases (poster, loading_direct, loading_blob,
          failed_poster_only) keep the play affordance above the poster so a
          not-yet-playing or degraded clip stays a recognizable video card. It
          is never shown over an actually playing surface. */}
      {posterVisible && <PlayBadge className="z-20" />}
    </div>
  );
}
