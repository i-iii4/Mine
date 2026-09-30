import { Camera, Crop } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ScreenshotPreviewProps {
  /** The frame to save; `null` until the first capture succeeds. */
  dataUrl: string | null;
  onRetake: () => void;
  onCrop: () => void;
  cropSupported: boolean;
  /** A capture is in flight: Retake and Crop wait for its answer (Б4.6). */
  capturing?: boolean;
  /** Why the last capture failed; the previous frame stays on screen. */
  error?: string | null;
}

export function ScreenshotPreview({
  dataUrl,
  onRetake,
  onCrop,
  cropSupported,
  capturing = false,
  error = null,
}: ScreenshotPreviewProps) {
  return (
    <div className="mine-clipper-section-stack min-h-0">
      {/* The image is the section's only elastic element: in a short viewport
          the box compresses and object-contain scales the screenshot down.
          The action row below is rigid — Crop Area and Retake must never
          shrink away or be painted over. */}
      <div className="flex min-h-24 shrink justify-center overflow-hidden rounded-1 border border-border bg-accent">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt=""
            className="block max-h-[220px] min-h-0 w-auto max-w-full rounded-1 object-contain"
          />
        ) : (
          <p className="self-center text-sm text-muted-foreground" role="status">
            {capturing ? "Taking a screenshot…" : "No screenshot yet"}
          </p>
        )}
      </div>
      {/* Always visible (unlike main app CardHoverMenu which reveals on
          hover) because the screenshot preview is the whole point of
          this clip type — the user must always be able to retake or
          crop without discovery. Standard Button variant="default"
          size="sm" with built-in hover (outline inset). While a capture
          is in flight both wait: a second request would race the first. */}
      <div className="flex shrink-0 gap-2">
        <Button
          variant="default"
          size="sm"
          className="flex-1"
          onClick={onCrop}
          disabled={!cropSupported || capturing}
        >
          Crop Area
          <Crop />
        </Button>
        <Button
          variant="default"
          size="sm"
          className="flex-1"
          onClick={onRetake}
          disabled={capturing}
        >
          Retake
          <Camera />
        </Button>
      </div>
      {/* The reason stays next to the frame it concerns; the editor, its
          title and collections are untouched by a failed capture. */}
      {error && (
        <p className="text-sm text-destructive" role="alert" data-clipper-capture-error="">
          {error}
        </p>
      )}
    </div>
  );
}
