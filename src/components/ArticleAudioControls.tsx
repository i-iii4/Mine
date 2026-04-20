import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Pause, Play, Trash2, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useArticleAudioGateway } from "@/lib/articleAudioGateway";
import type { ArticleAudioState } from "@/types";
import { cn } from "@/lib/utils";

interface ArticleAudioControlsProps {
  slug: string;
  blockType: string;
  url: string | null;
}

function supportsArticleAudio(blockType: string, url: string | null): boolean {
  if (blockType !== "article") {
    return false;
  }
  if (!url) {
    return true;
  }
  const normalized = url.toLowerCase();
  if ((normalized.includes("twitter.com/") || normalized.includes("x.com/")) && normalized.includes("/status/")) {
    return false;
  }
  if (normalized.includes("instagram.com/p/") || normalized.includes("instagram.com/reel/") || normalized.includes("instagram.com/stories/")) {
    return false;
  }
  return true;
}

function formatAudioTime(ms: number | null): string {
  if (ms == null || ms < 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function ArticleAudioControls({
  slug,
  blockType,
  url,
}: ArticleAudioControlsProps) {
  const pendingPlayRef = useRef(false);
  const isReadyRef = useRef(false);
  const isPlayingRef = useRef(false);
  const durationMsRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const playOffsetMsRef = useRef(0);
  const playStartedAtRef = useRef(0);

  const [audioState, setAudioState] = useState<ArticleAudioState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPreparingPlayback, setIsPreparingPlayback] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const articleAudio = useArticleAudioGateway();

  const isSupported = supportsArticleAudio(blockType, url);
  const playbackSource = useMemo(
    () => (audioState ? articleAudio.resolvePlaybackSource(audioState) : null),
    [articleAudio, audioState],
  );
  const isReady = audioState?.status === "ready" && playbackSource !== null;

  useEffect(() => {
    isReadyRef.current = isReady;
  }, [isReady]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    durationMsRef.current = durationMs;
  }, [durationMs]);

  const percentComplete = useMemo(() => {
    if (!durationMs || durationMs <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (currentTimeMs / durationMs) * 100));
  }, [currentTimeMs, durationMs]);

  const loadState = useCallback(async () => {
    if (!isSupported) {
      setAudioState(null);
      setCurrentTimeMs(0);
      setDurationMs(null);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextState = await articleAudio.getState(slug);
      setAudioState(nextState);
      setCurrentTimeMs(nextState.last_position_ms);
      playOffsetMsRef.current = nextState.last_position_ms;
      setDurationMs(nextState.duration_ms);
      durationMsRef.current = nextState.duration_ms;
      setErrorMessage(null);
      setIsPlaying(false);
      isPlayingRef.current = false;
      pendingPlayRef.current = false;
    } catch (error) {
      setAudioState(null);
      setCurrentTimeMs(0);
      playOffsetMsRef.current = 0;
      setDurationMs(null);
      durationMsRef.current = null;
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
      setIsGenerating(false);
      setIsRemoving(false);
    }
  }, [articleAudio, isSupported, slug]);

  const clearProgressTimer = useCallback(() => {
    if (progressTimerRef.current != null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const ensureAudioContext = useCallback(() => {
    if (audioContextRef.current) {
      return audioContextRef.current;
    }
    const Context =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Context) {
      return null;
    }
    const context = new Context();
    audioContextRef.current = context;
    return context;
  }, []);

  const stopSourceNode = useCallback(() => {
    const source = sourceNodeRef.current;
    sourceNodeRef.current = null;
    if (!source) {
      return;
    }
    source.onended = null;
    try {
      source.stop();
    } catch {
      // no-op: stopping an already ended source is expected
    }
    source.disconnect();
  }, []);

  const getEffectiveDurationMs = useCallback(() => {
    if (durationMsRef.current != null) {
      return durationMsRef.current;
    }
    const buffer = audioBufferRef.current;
    return buffer ? Math.round(buffer.duration * 1000) : null;
  }, []);

  const computeCurrentPlaybackPositionMs = useCallback(() => {
    if (!isPlayingRef.current || !audioContextRef.current) {
      return playOffsetMsRef.current;
    }
    const elapsedMs = Math.max(
      0,
      Math.round((audioContextRef.current.currentTime - playStartedAtRef.current) * 1000),
    );
    const nextPositionMs = playOffsetMsRef.current + elapsedMs;
    const maxDurationMs = getEffectiveDurationMs();
    if (maxDurationMs == null) {
      return nextPositionMs;
    }
    return Math.min(maxDurationMs, nextPositionMs);
  }, [getEffectiveDurationMs]);

  const persistPlaybackPosition = useCallback(async (
    completed: boolean,
    explicitPositionMs?: number,
    explicitDurationMs?: number | null,
  ) => {
    if (!isReadyRef.current) {
      return;
    }
    const nextDurationMs = explicitDurationMs ?? getEffectiveDurationMs();
    const nextPositionMs = completed
      ? 0
      : explicitPositionMs ?? computeCurrentPlaybackPositionMs();

    try {
      await articleAudio.setPosition(
        slug,
        nextPositionMs,
        nextDurationMs ?? null,
        completed,
      );
      setAudioState((current) => {
        if (!current || current.status !== "ready") {
          return current;
        }
        return {
          ...current,
          duration_ms: nextDurationMs ?? current.duration_ms,
          last_position_ms: completed ? 0 : nextPositionMs,
          completed_at: completed ? new Date().toISOString() : null,
        };
      });
      setCurrentTimeMs(completed ? 0 : nextPositionMs);
      playOffsetMsRef.current = completed ? 0 : nextPositionMs;
      if (nextDurationMs != null) {
        setDurationMs(nextDurationMs);
        durationMsRef.current = nextDurationMs;
      }
    } catch (error) {
      console.error("Failed to persist article audio playback position:", error);
    }
  }, [articleAudio, computeCurrentPlaybackPositionMs, getEffectiveDurationMs, slug]);

  const startPlayback = useCallback(async () => {
    const context = ensureAudioContext();
    const buffer = audioBufferRef.current;
    if (!context || !buffer) {
      return;
    }

    clearProgressTimer();
    stopSourceNode();

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      clearProgressTimer();
      sourceNodeRef.current = null;
      setIsPlaying(false);
      isPlayingRef.current = false;
      setCurrentTimeMs(0);
      playOffsetMsRef.current = 0;
      void persistPlaybackPosition(true, 0, Math.round(buffer.duration * 1000));
    };

    try {
      await context.resume();
      playStartedAtRef.current = context.currentTime;
      sourceNodeRef.current = source;
      source.start(0, playOffsetMsRef.current / 1000);
      setIsPlaying(true);
      isPlayingRef.current = true;
      progressTimerRef.current = window.setInterval(() => {
        setCurrentTimeMs(computeCurrentPlaybackPositionMs());
      }, 250);
    } catch (error) {
      source.onended = null;
      source.disconnect();
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setIsPlaying(false);
      isPlayingRef.current = false;
    }
  }, [
    clearProgressTimer,
    computeCurrentPlaybackPositionMs,
    ensureAudioContext,
    persistPlaybackPosition,
    stopSourceNode,
  ]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!isSupported) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void articleAudio.subscribe((event) => {
      if (event.slug === slug) {
        void loadState();
      }
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    });
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [articleAudio, isSupported, loadState, slug]);

  useEffect(() => {
    return () => {
      if (!isReadyRef.current) {
        return;
      }
      clearProgressTimer();
      const lastPositionMs = computeCurrentPlaybackPositionMs();
      stopSourceNode();
      void persistPlaybackPosition(false, lastPositionMs);
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, [
    clearProgressTimer,
    computeCurrentPlaybackPositionMs,
    persistPlaybackPosition,
    stopSourceNode,
  ]);

  useEffect(() => {
    if (!isReady || !playbackSource) {
      clearProgressTimer();
      stopSourceNode();
      audioBufferRef.current = null;
      setIsPreparingPlayback(false);
      pendingPlayRef.current = false;
      return;
    }

    const context = ensureAudioContext();
    if (!context) {
      setErrorMessage("Web Audio API is unavailable in this environment.");
      return;
    }

    let cancelled = false;
    clearProgressTimer();
    stopSourceNode();
    audioBufferRef.current = null;
    setIsPreparingPlayback(true);

    fetch(playbackSource.url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Audio fetch failed with HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((arrayBuffer) => context.decodeAudioData(arrayBuffer.slice(0)))
      .then((decodedBuffer) => {
        if (cancelled) {
          return;
        }
        audioBufferRef.current = decodedBuffer;
        const nextDurationMs = Math.round(decodedBuffer.duration * 1000);
        setDurationMs(nextDurationMs);
        durationMsRef.current = nextDurationMs;
        setCurrentTimeMs(audioState.last_position_ms);
        playOffsetMsRef.current = audioState.last_position_ms;
        setErrorMessage(null);
        if (audioState.duration_ms == null) {
          void articleAudio.setPosition(
            slug,
            audioState.last_position_ms,
            nextDurationMs,
            false,
          );
        }
        if (pendingPlayRef.current) {
          pendingPlayRef.current = false;
          void startPlayback();
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        pendingPlayRef.current = false;
        setErrorMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setIsPreparingPlayback(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    articleAudio,
    audioState,
    clearProgressTimer,
    ensureAudioContext,
    isReady,
    playbackSource,
    slug,
    stopSourceNode,
    startPlayback,
  ]);

  const handleCreateAudio = useCallback(async () => {
    setIsGenerating(true);
    setErrorMessage(null);
    try {
      const nextState = await articleAudio.generate(slug);
      setAudioState(nextState);
      setCurrentTimeMs(nextState.last_position_ms);
      playOffsetMsRef.current = nextState.last_position_ms;
      setDurationMs(nextState.duration_ms);
      durationMsRef.current = nextState.duration_ms;
      setIsPlaying(false);
      isPlayingRef.current = false;
      pendingPlayRef.current = false;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsGenerating(false);
    }
  }, [articleAudio, slug]);

  const handleRemoveAudio = useCallback(async () => {
    setIsRemoving(true);
    setErrorMessage(null);
    clearProgressTimer();
    stopSourceNode();
    audioBufferRef.current = null;
    setIsPlaying(false);
    isPlayingRef.current = false;

    try {
      await articleAudio.remove(slug);
      setAudioState({
        status: "absent",
        audio_path: null,
        duration_ms: null,
        last_position_ms: 0,
        completed_at: null,
      });
      setCurrentTimeMs(0);
      playOffsetMsRef.current = 0;
      setDurationMs(null);
      durationMsRef.current = null;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      pendingPlayRef.current = false;
      setIsRemoving(false);
    }
  }, [articleAudio, clearProgressTimer, slug, stopSourceNode]);

  const handleTogglePlayback = useCallback(async () => {
    if (!isReady) {
      return;
    }

    if (isPlaying) {
      const nextPositionMs = computeCurrentPlaybackPositionMs();
      pendingPlayRef.current = false;
      clearProgressTimer();
      stopSourceNode();
      setIsPlaying(false);
      isPlayingRef.current = false;
      setCurrentTimeMs(nextPositionMs);
      playOffsetMsRef.current = nextPositionMs;
      await persistPlaybackPosition(false, nextPositionMs);
      return;
    }

    setErrorMessage(null);
    const context = ensureAudioContext();
    if (!context) {
      setErrorMessage("Web Audio API is unavailable in this environment.");
      return;
    }
    if (context.state === "suspended") {
      await context.resume().catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }
    if (!audioBufferRef.current) {
      pendingPlayRef.current = true;
      return;
    }
    pendingPlayRef.current = false;
    setIsPreparingPlayback(false);
    await startPlayback();
  }, [
    clearProgressTimer,
    computeCurrentPlaybackPositionMs,
    ensureAudioContext,
    isPlaying,
    isReady,
    persistPlaybackPosition,
    startPlayback,
    stopSourceNode,
  ]);

  if (!isSupported) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        <Volume2 className="size-3.5" />
        <span>AUDIO</span>
      </div>

      {isReady ? (
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={handleRemoveAudio}
            disabled={isRemoving}
            className="justify-start gap-2 px-0 font-mono"
          >
            <Trash2 className="size-3.5" />
            {isRemoving ? "Removing Audio…" : "Remove Audio"}
          </Button>

          <Button
            type="button"
            variant="default"
            onClick={handleTogglePlayback}
            disabled={isPreparingPlayback && !audioBufferRef.current}
            className="justify-start gap-2 font-mono"
          >
            {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {isPlaying ? "Pause" : isPreparingPlayback && !audioBufferRef.current ? "Preparing Audio…" : "Play"}
          </Button>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-muted-foreground">
              <span>{formatAudioTime(currentTimeMs)}</span>
              <span>{formatAudioTime(durationMs)}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-accent">
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-150"
                style={{ width: `${percentComplete}%` }}
              />
            </div>
          </div>

        </>
      ) : (
        <Button
          type="button"
          variant="default"
          onClick={handleCreateAudio}
          disabled={isLoading || isGenerating}
          className="justify-start gap-2 font-mono"
        >
          {(isLoading || isGenerating) && <LoaderCircle className="size-3.5 animate-spin" />}
          {!isLoading && !isGenerating && <Volume2 className="size-3.5" />}
          {isLoading ? "Loading…" : isGenerating ? "Creating Audio…" : errorMessage ? "Retry" : "Create Audio"}
        </Button>
      )}

      {errorMessage && (
        <p className={cn("text-xs leading-5 text-destructive", isReady && "pt-1")}>
          {errorMessage}
        </p>
      )}
    </div>
  );
}
