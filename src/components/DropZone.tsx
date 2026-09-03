import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { createBlock } from "@/lib/commands";
import { fileNameToTitle, inferBlockType } from "@/lib/pasteImport";

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
  const onBlocksCreatedRef = useRef(onBlocksCreated);
  onBlocksCreatedRef.current = onBlocksCreated;
  const importingRef = useRef(false);
  const fileDragActiveRef = useRef(false);

  const handleDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || importingRef.current) return;
      importingRef.current = true;

      setDragging(false);
      setImporting(true);
      setError(null);

      const tags = currentTagRef.current ? [currentTagRef.current] : [];

      try {
        for (const filePath of [...new Set(paths)]) {
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const blockType = inferBlockType(ext);
          const title = fileNameToTitle(filePath);

          await createBlock({
            block_type: blockType,
            title,
            url: null,
            tags,
            file_path: filePath,
          });
        }
        onBlocksCreatedRef.current();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to create block from drop:", msg);
        setError(msg);
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          fileDragActiveRef.current = event.payload.paths.length > 0;
          setDragging(fileDragActiveRef.current);
        } else if (event.payload.type === "over") {
          if (!fileDragActiveRef.current) return;
          setDragging(true);
        } else if (event.payload.type === "drop") {
          const shouldHandleDrop = fileDragActiveRef.current || event.payload.paths.length > 0;
          fileDragActiveRef.current = false;
          if (shouldHandleDrop) {
            handleDrop(event.payload.paths);
          } else {
            setDragging(false);
          }
        } else if (event.payload.type === "leave") {
          fileDragActiveRef.current = false;
          setDragging(false);
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleDrop]);

  useEffect(() => {
    if (!dragging) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      fileDragActiveRef.current = false;
      setDragging(false);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [dragging]);

  // Auto-hide error after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  if (!dragging && !importing && !error) return null;

  return (
    <div className="fixed top-8 right-0 bottom-8 left-0 z-50 flex items-center justify-center bg-glass">
      {dragging && (
        <div className="pointer-events-none absolute inset-2 rounded-[4px] border border-dashed border-border dark:border-muted-foreground" />
      )}
      {error ? (
        <div className="max-w-sm rounded-1 bg-destructive p-6 shadow-lg">
          <p className="text-lg font-semibold text-white">
            Failed to import
          </p>
          <p className="mt-1 text-base text-white/80">{error}</p>
        </div>
      ) : (
        <div className="rounded-1 border border-border bg-background p-6 shadow-lg">
          <p className="text-lg font-semibold text-foreground">
            {importing ? "Importing..." : "Drop files to add"}
          </p>
          {!importing && (
            <p className="mt-1 text-base text-muted-foreground">
              Images, videos, PDFs, documents
            </p>
          )}
        </div>
      )}
    </div>
  );
}
