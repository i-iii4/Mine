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

/** The fallback holds the whole file in memory. It is meant for clips; a
 *  longer video stays on the direct source instead of filling the memory of
 *  the window (SPEC_AUDIT_FIXES.md, А7.6). */
export const MAX_BLOB_VIDEO_BYTES = 150 * 1024 * 1024;

class TooLargeForMemory extends Error {}

/** Read a response into one blob, refusing past `limit` bytes. */
async function readLimited(response: Response, limit: number, controller: AbortController): Promise<Blob> {
  const declared = Number(response.headers?.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw new TooLargeForMemory();
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > limit) throw new TooLargeForMemory();
    return blob;
  }
  const parts: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      controller.abort();
      throw new TooLargeForMemory();
    }
    parts.push(value);
  }
  return new Blob(parts, { type: response.headers?.get("Content-Type") ?? "video/mp4" });
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
  const [mode, setMode] = useState<"direct" | "blob">("direct");
  // A file too large for memory keeps the direct source for good.
  const [blobAllowed, setBlobAllowed] = useState(true);
  const [directReady, setDirectReady] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preload = autoPlay ? "auto" : "metadata";

  useEffect(() => {
    setMode("direct");
    setBlobAllowed(true);
    setDirectReady(false);
    setBlobUrl(null);
    setError(null);
  }, [src]);

  useEffect(() => {
    if (mode !== "direct" || directReady || !blobAllowed) return;
    const timer = window.setTimeout(() => {
      setMode((current) => (current === "direct" ? "blob" : current));
    }, DIRECT_VIDEO_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [mode, directReady, blobAllowed, src]);

  useEffect(() => {
    if (mode !== "blob") return;
    let cancelled = false;
    let createdUrl: string | null = null;
    // Closing the video stops the read: nothing keeps loading for a card
    // that is gone.
    const controller = new AbortController();
    fetch(src, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return readLimited(r, MAX_BLOB_VIDEO_BYTES, controller);
      })
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof TooLargeForMemory) {
          setBlobAllowed(false);
          setMode("direct");
          return;
        }
        setError(String(e));
      });
    return () => {
      cancelled = true;
      controller.abort();
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
