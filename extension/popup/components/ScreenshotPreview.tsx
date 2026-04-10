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
    <div className="group relative rounded-1 border border-border bg-accent">
      {/* Overlay — затенение при hover (токен из дизайн-системы) */}
      <div className="pointer-events-none absolute inset-0 z-[4] bg-[var(--card-hover-overlay)] opacity-0 transition-opacity group-hover:opacity-100" />

      <img
        src={dataUrl}
        alt=""
        className="mx-auto block max-h-[220px] w-auto max-w-full rounded-1 object-contain"
      />

      {/* Нижний ряд: Crop Area (лево) + Retake (право) — паттерн CardHoverMenu */}
      <div className="absolute bottom-2 left-2 right-2 z-[5] flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          variant="default"
          size="default"
          className="flex-1"
          onClick={onCrop}
          disabled={!cropSupported}
        >
          Crop Area
          <Crop className="size-3" />
        </Button>
        <Button
          variant="default"
          size="default"
          className="flex-1"
          onClick={onRetake}
        >
          Retake
          <Camera className="size-3" />
        </Button>
      </div>
    </div>
  );
}
