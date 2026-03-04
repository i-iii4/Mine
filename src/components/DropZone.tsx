import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowDown } from "lucide-react";
import type { BlockType } from "@/types";
import { createBlock } from "@/lib/commands";
import { isInternalDragActive } from "@/lib/drag";

interface DropZoneProps {
  currentTag?: string;
  onBlocksCreated: () => void;
}

export function DropZone({ currentTag, onBlocksCreated }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs to avoid re-registering the Tauri listener on navigation
  const currentTagRef = useRef(currentTag);
  currentTagRef.current = currentTag;
  const importingRef = useRef(false);

  const handleDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || importingRef.current) return;
      importingRef.current = true;

      setDragging(false);
      setImporting(true);
      setError(null);

      const tags = currentTagRef.current ? [currentTagRef.current] : [];

      try {
        for (const filePath of paths) {
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const blockType = inferBlockType(ext);
          const title = fileNameToTitle(filePath);

          await createBlock({
            block_type: blockType,
            title,
            tags,
            file_path: filePath,
          });
        }
        onBlocksCreated();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to create block from drop:", msg);
        setError(msg);
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [onBlocksCreated],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          if (!isInternalDragActive()) setDragging(true);
        } else if (event.payload.type === "drop") {
          handleDrop(event.payload.paths);
        } else if (event.payload.type === "leave") {
          setDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => unlisten?.();
  }, [handleDrop]);

  // Auto-hide error after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  if (!dragging && !importing && !error) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      {error ? (
        <div className="max-w-sm rounded-1 bg-destructive px-8 py-6 shadow-2xl">
          <p className="text-base font-semibold text-white">
            Failed to import
          </p>
          <p className="mt-1 text-sm text-white/80">{error}</p>
        </div>
      ) : importing ? (
        <div className="rounded-1 bg-card px-8 py-6 shadow-2xl">
          <p className="text-base font-semibold text-foreground">
            Importing...
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-1 border-2 border-dashed border-white/50 px-16 py-12">
          <ArrowDown className="size-10 text-white" strokeWidth={2} />
          <p className="text-lg font-semibold text-white">Drop files to add</p>
          <p className="text-base text-white/60">
            Images, videos, PDFs, documents
          </p>
        </div>
      )}
    </div>
  );
}

function inferBlockType(ext: string): BlockType {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "file";
}

function fileNameToTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  const stem = name.replace(/\.[^.]+$/, "");
  return stem
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "svg",
]);

const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v",
]);

