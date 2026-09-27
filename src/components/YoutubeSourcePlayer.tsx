import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { youtubePlayerUrl } from "@/lib/commands";
import type { YoutubeSource } from "@/lib/youtubeSource";

type PlayerPage =
  | { status: "pending" }
  | { status: "ready"; url: string }
  | { status: "failed" };

/** The player loads as soon as the card opens and waits for the user to start it.
 *  It lives in a local page, not in this document: YouTube needs a referrer
 *  that the interface origin cannot send (player error 153). */
export function YoutubeSourcePlayer({ source, poster, title }: {
  source: YoutubeSource;
  poster: string | null;
  title: string;
}) {
  const [page, setPage] = useState<PlayerPage>({ status: "pending" });

  useEffect(() => {
    let current = true;
    setPage({ status: "pending" });
    youtubePlayerUrl(source.sourceUrl).then(
      (url) => { if (current) setPage({ status: "ready", url }); },
      (error: unknown) => {
        console.error("Could not prepare the video player:", error);
        if (current) setPage({ status: "failed" });
      },
    );
    return () => { current = false; };
  }, [source.sourceUrl]);

  return (
    <div className="mb-6" data-youtube-source-player={source.videoId}>
      <div className="relative aspect-video overflow-hidden rounded-1 bg-black">
        {page.status === "ready" ? (
          <iframe
            src={page.url}
            title={`${title} on YouTube`}
            className="h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : (
          <>
            {poster && <img src={poster} alt="" className="absolute h-full w-full object-contain" />}
            {page.status === "failed" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="rounded-1 bg-black/70 px-3 py-2 text-sm text-white">This video can't play inside Mine.</p>
              </div>
            )}
          </>
        )}
      </div>
      <a
        href={source.sourceUrl}
        className="mt-2 inline-block text-sm text-muted-foreground underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault();
          void openUrl(source.sourceUrl).catch((error) => console.error("Could not open video source:", error));
        }}
      >Open on YouTube</a>
    </div>
  );
}
