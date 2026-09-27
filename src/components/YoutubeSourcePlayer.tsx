import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { YoutubeSource } from "@/lib/youtubeSource";

/** External requests start only after the user chooses playback. */
export function YoutubeSourcePlayer({ source, poster, title }: {
  source: YoutubeSource;
  poster: string | null;
  title: string;
}) {
  const [started, setStarted] = useState(false);
  return (
    <div className="mb-6" data-youtube-source-player={source.videoId}>
      <div className="relative aspect-video overflow-hidden rounded-1 bg-black">
        {started ? (
          <iframe
            src={`${source.embedUrl}?autoplay=1`}
            title={`${title} on YouTube`}
            className="h-full w-full"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        ) : (
          <>
            {poster && <img src={poster} alt="" className="absolute h-full w-full object-contain" />}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <Button onClick={() => setStarted(true)}>
                <Play />Play video
              </Button>
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
