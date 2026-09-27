import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { youtubePlayerUrl } from "@/lib/commands";
import type { YoutubeSource } from "@/lib/youtubeSource";

type PlayerPage =
  | { status: "pending" }
  | { status: "ready"; url: string }
  | { status: "failed" };

/** External requests start only after the user chooses playback.
 *  The player lives in a local page, not in this document: YouTube needs a
 *  referrer that the interface origin cannot send (player error 153). */
export function YoutubeSourcePlayer({ source, poster, title }: {
  source: YoutubeSource;
  poster: string | null;
  title: string;
}) {
  const [started, setStarted] = useState(false);
  const [page, setPage] = useState<PlayerPage>({ status: "pending" });

  // The local address is resolved before the click, so the frame is created
  // inside the user's gesture and the player may start with sound.
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
        {started && page.status === "ready" ? (
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
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              {page.status === "failed" ? (
                <p className="rounded-1 bg-black/70 px-3 py-2 text-sm text-white">This video can't play inside Mine.</p>
              ) : (
                <Button onClick={() => setStarted(true)} disabled={started}>
                  <Play />Play video
                </Button>
              )}
            </div>
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
