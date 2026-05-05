import { useEffect, useState } from "react";

interface VideoFromBlobProps {
  src: string;
  className?: string;
  controls?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
}

const DIRECT_VIDEO_FALLBACK_MS = 2500;

/**
 * Video renderer that fetches the asset:// URL, wraps the bytes in a blob
 * URL and feeds that to the <video> element.
 *
 * Kept as a defensive workaround after a session where WKWebView's
 * persistent media storage (~/Library/WebKit/com.mine.app/WebsiteData/,
 * specifically MediaKeys/salts) corrupted itself during a long dev
 * session with HMR storm + file watcher activity. Symptom was
 * `<video>` stuck at net=LOADING ready=NOTHING err=none forever for
 * BOTH asset:// and blob: sources. The real fix was a hard wipe of
 * WebKit storage, but going through blob URLs avoids any possible
 * future Accept-Ranges issues in Tauri asset protocol and adds only
 * ~100ms latency for typical clip-sized videos.
 */
export function VideoFromBlob({
  src,
  className,
  controls = false,
  autoPlay = false,
  loop = false,
  muted = false,
}: VideoFromBlobProps) {
  const [mode, setMode] = useState<"direct" | "blob">("direct");
  const [directReady, setDirectReady] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preload = autoPlay ? "auto" : "metadata";

  useEffect(() => {
    setMode("direct");
    setDirectReady(false);
    setBlobUrl(null);
    setError(null);
  }, [src]);

  useEffect(() => {
    if (mode !== "direct" || directReady) return;
    const timer = window.setTimeout(() => {
      setMode((current) => (current === "direct" ? "blob" : current));
    }, DIRECT_VIDEO_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [mode, directReady, src]);

  useEffect(() => {
    if (mode !== "blob") return;
    let cancelled = false;
    let createdUrl: string | null = null;
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [mode, src]);

  if (mode === "direct") {
    return (
      <video
        src={src}
        className={className}
        controls={controls}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        draggable={false}
        playsInline
        preload={preload}
        onLoadedData={() => {
          setDirectReady(true);
          setError(null);
        }}
        onError={() => {
          if (!directReady) {
            setMode("blob");
          }
        }}
      />
    );
  }

  if (error || !blobUrl) {
    return <video className={className} controls={controls} draggable={false} playsInline preload={preload} />;
  }

  return (
    <video
      src={blobUrl}
      className={className}
      controls={controls}
      autoPlay={autoPlay}
      loop={loop}
      muted={muted}
      draggable={false}
      playsInline
      preload={preload}
    />
  );
}
