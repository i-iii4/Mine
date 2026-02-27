import { useEffect, useState, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { BlockType } from "@/types";
import { createBlock } from "@/lib/commands";

interface DropZoneProps {
  onBlocksCreated: () => void;
}

export function DropZone({ onBlocksCreated }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;

      setDragging(false);
      setImporting(true);

      try {
        for (const filePath of paths) {
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const blockType = inferBlockType(ext);
          const title = fileNameToTitle(filePath);

          await createBlock({
            block_type: blockType,
            title,
            tags: [],
            file_path: filePath,
          });
        }
        onBlocksCreated();
      } catch (e) {
        console.error("Failed to create block from drop:", e);
      } finally {
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
          setDragging(true);
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

  if (!dragging && !importing) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      {importing ? (
        <div className="rounded-2xl bg-white px-8 py-6 shadow-2xl dark:bg-neutral-900">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Importing...
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/50 px-16 py-12">
          <DropIcon />
          <p className="text-lg font-medium text-white">Drop files to add</p>
          <p className="text-sm text-white/60">
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

function DropIcon() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 40 40"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6v20M12 18l8 8 8-8" />
      <path d="M6 28v4a2 2 0 002 2h24a2 2 0 002-2v-4" />
    </svg>
  );
}
