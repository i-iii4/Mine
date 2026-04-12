import { useEffect, useState } from "react";

interface VideoFromBlobProps {
  src: string;
  className?: string;
  controls?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
}

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
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [src]);

  if (error || !blobUrl) {
    return <video className={className} controls={controls} playsInline />;
  }

  return (
    <video
      src={blobUrl}
      className={className}
      controls={controls}
      autoPlay={autoPlay}
      loop={loop}
      muted={muted}
      playsInline
    />
  );
}
