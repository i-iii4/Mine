import { Camera, Crop } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  return (
    <div className="mine-clipper-section-stack min-h-0">
      {/* The image is the section's only elastic element: in a short viewport
          the box compresses and object-contain scales the screenshot down.
          The action row below is rigid — Crop Area and Retake must never
          shrink away or be painted over. */}
      <div className="flex min-h-24 shrink justify-center overflow-hidden rounded-1 border border-border bg-accent">
        <img
          src={dataUrl}
          alt=""
          className="block max-h-[220px] min-h-0 w-auto max-w-full rounded-1 object-contain"
        />
      </div>
      {/* Always visible (unlike main app CardHoverMenu which reveals on
          hover) because the screenshot preview is the whole point of
          this clip type — the user must always be able to retake or
          crop without discovery. Standard Button variant="default"
          size="sm" with built-in hover (outline inset). */}
      <div className="flex shrink-0 gap-2">
        <Button
          variant="default"
          size="sm"
          className="flex-1"
          onClick={onCrop}
          disabled={!cropSupported}
        >
          Crop Area
          <Crop />
        </Button>
        <Button
          variant="default"
          size="sm"
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
