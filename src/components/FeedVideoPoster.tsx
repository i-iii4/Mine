import { useEffect, useMemo, useState } from "react";

interface FeedVideoPosterProps {
  candidateUrls: string[];
  alt?: string;
  className?: string;
  loading?: "eager" | "lazy";
}

export function FeedVideoPoster({
  candidateUrls,
  alt = "",
  className,
  loading = "lazy",
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

  if (exhausted) {
    return null;
  }

  const src = candidates[index];
  if (!src) {
    return null;
  }

  return (
    <img
      data-feed-video-poster="true"
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      draggable={false}
      onError={() => {
        const next = index + 1;
        if (next < candidates.length) {
          setIndex(next);
          return;
        }
        setExhausted(true);
      }}
    />
  );
}
