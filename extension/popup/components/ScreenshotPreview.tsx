import { useEffect, useState } from "react";
import { Camera, Crop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScreenshotPreviewProps {
  dataUrl: string;
  onRetake: () => void;
  onCrop: () => void;
  cropSupported: boolean;
}

export function ScreenshotPreview({
  dataUrl,
  onRetake,
  onCrop,
  cropSupported,
}: ScreenshotPreviewProps) {
  // The popup-level gate (clipper.screenshotDataUrl ? preview : skeleton)
  // flips the moment captureVisibleTab's callback runs, but the browser
  // still has to decode the data URL — which for a 1–10 MB base64 JPEG
  // takes 50–200 ms. Between those two moments the <img> element exists
  // but renders nothing, exposing the bare rounded container and the
  // page title bleeding through — exactly the "visual garbage" users
  // reported. Hold the same spinner skeleton until onLoad fires so the
  // handoff from capturing → loaded is visually seamless.
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    setImgLoaded(false);
  }, [dataUrl]);

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "relative flex items-center justify-center rounded-1 border border-border bg-accent overflow-hidden",
          !imgLoaded && "min-h-[220px]",
        )}
      >
        {!imgLoaded && (
          <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <div className="size-4 animate-spin rounded-round border-[1.5px] border-border border-t-foreground" />
            <span>Capturing screenshot…</span>
          </div>
        )}
        <img
          src={dataUrl}
          alt=""
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgLoaded(true)}
          className={cn(
            "mx-auto block max-h-[220px] w-auto max-w-full rounded-1 object-contain",
            !imgLoaded && "hidden",
          )}
        />
      </div>
      {/* Always visible (unlike main app CardHoverMenu which reveals on
          hover) because the screenshot preview is the whole point of
          this clip type — the user must always be able to retake or
          crop without discovery. Standard Button variant="default"
          size="xs" with built-in hover (outline inset). */}
      <div className="flex gap-2">
        <Button
          variant="default"
          size="xs"
          className="flex-1"
          onClick={onCrop}
          disabled={!cropSupported || !imgLoaded}
        >
          Crop Area
          <Crop />
        </Button>
        <Button
          variant="default"
          size="xs"
          className="flex-1"
          onClick={onRetake}
        >
          Retake
          <Camera />
        </Button>
      </div>
    </div>
  );
}
