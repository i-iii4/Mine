import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePreparedPicture } from "@/hooks/usePreparedPicture";

interface FeedVideoPosterProps {
  candidateUrls: string[];
  alt?: string;
  className?: string;
  loading?: "eager" | "lazy";
  /** Painted in the poster's place when no candidate loads, or there is none. */
  fallback?: ReactNode;
}

export function FeedVideoPoster({
  candidateUrls,
  alt = "",
  className,
  loading = "lazy",
  fallback = null,
}: FeedVideoPosterProps) {
  const candidates = useMemo(() => {
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidateUrls) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      urls.push(candidate);
    }
    return urls;
  }, [candidateUrls]);

  const [index, setIndex] = useState(0);
  const [exhausted, setExhausted] = useState(candidates.length === 0);

  useEffect(() => {
    setIndex(0);
    setExhausted(candidates.length === 0);
  }, [candidates]);

  const src = exhausted ? null : candidates[index] ?? null;
  // A poster that does not load and one that cannot be decoded fail the same
  // way: the next candidate, then the fallback.
  const failCandidate = useCallback(() => {
    const next = index + 1;
    if (next < candidates.length) {
      setIndex(next);
      return;
    }
    setExhausted(true);
  }, [candidates.length, index]);
  const preparedPicture = usePreparedPicture(src, failCandidate);

  if (src === null) {
    return fallback;
  }

  return (
    <img
      ref={preparedPicture}
      data-feed-video-poster="true"
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      draggable={false}
      onError={failCandidate}
    />
  );
}
