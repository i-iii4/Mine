import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, previewAssetUrl } from "@/lib/assets";
import type { NormalizedFeedPlaybackDescriptor } from "@/lib/feedPlayback";
import { FeedVideoPoster } from "./FeedVideoPoster";

export const FEED_VIDEO_DIRECT_TIMEOUT_MS = 1200;
export const FEED_VIDEO_BLOB_TIMEOUT_MS = 1800;
export const FEED_VIDEO_HEAVY_DIRECT_TIMEOUT_MS = 3500;

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
  const usesBlobFallback = playback.profile === "standard";
  const directFailurePhase: "loading_blob" | "failed_poster_only" =
    usesBlobFallback ? "loading_blob" : "failed_poster_only";
  const directTimeoutMs =
    playback.profile === "heavy"
      ? FEED_VIDEO_HEAVY_DIRECT_TIMEOUT_MS
      : FEED_VIDEO_DIRECT_TIMEOUT_MS;

  useEffect(() => {
    setPhase(allowPlayback ? "loading_direct" : "poster");
    setBlobUrl(null);
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
    const timer = window.setTimeout(() => {
      setPhase((current) =>
        current === "loading_direct" ? directFailurePhase : current,
      );
    }, directTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [attemptPlay, directFailurePhase, directTimeoutMs, phase]);

  useEffect(() => {
    if (phase !== "loading_blob") return;
    attemptPlay(
      blobVideoRef.current,
      "loading_blob",
      "playing_blob",
      "failed_poster_only",
    );
    const timeoutId = window.setTimeout(() => {
      setPhase((current) =>
        current === "loading_blob" ? "failed_poster_only" : current,
      );
    }, FEED_VIDEO_BLOB_TIMEOUT_MS);

    const controller = new AbortController();
    let cancelled = false;

    void fetch(directSrc, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
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
      window.clearTimeout(timeoutId);
    };
  }, [attemptPlay, directSrc, phase]);

  const posterVisible =
    phase !== "playing_direct" && phase !== "playing_blob";

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
          posterVisible ? "opacity-100" : "opacity-0"
        }`}
        loading="eager"
      />

      {(phase === "loading_direct" || phase === "playing_direct") && (
        <video
          ref={directVideoRef}
          src={directSrc}
          className={className}
          autoPlay
          loop
          muted
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
          className={className}
          autoPlay
          loop
          muted
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
    </div>
  );
}
