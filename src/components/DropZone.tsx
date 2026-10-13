import { useEffect, useState, useCallback, useRef } from "react";

import { createElementsInTurn } from "@/lib/createElements";
import { listenPage } from "@/lib/pageEvents";
import { fileNameToTitle, inferBlockType } from "@/lib/pasteImport";
import { createElementsFailureTitle, reportActionError } from "@/lib/actionFailures";
import type { TabFileDrag } from "@/types";

/** Files dragged over the window, sent by the backend to the tab the window
 *  shows (SPEC_TABS.md, В22; src-tauri/src/tabs/mod.rs, `TAB_FILE_DRAG_EVENT`). */
export const TAB_FILE_DRAG_EVENT = "tab-file-drag";

interface DropZoneProps {
  currentTag?: string;
  onBlocksCreated: () => void;
}

export function DropZone({ currentTag, onBlocksCreated }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  // Drops still being added: a drop during another waits its turn
  // (SPEC_DEEP_AUDIT.md, Е6.5).
  const [importing, setImporting] = useState(0);

  // Refs to avoid re-registering the Tauri listener on navigation
  const currentTagRef = useRef(currentTag);
  currentTagRef.current = currentTag;
  const onBlocksCreatedRef = useRef(onBlocksCreated);
  onBlocksCreatedRef.current = onBlocksCreated;
  const fileDragActiveRef = useRef(false);

  // Every file of the drop becomes an element, past one that fails; what
  // failed is the tab's notice (src/lib/createElements.ts, Н11).
  const handleDrop = useCallback(
    async (paths: string[]) => {
      setDragging(false);
      if (paths.length === 0) return;
      setImporting((count) => count + 1);
      const tags = currentTagRef.current ? [currentTagRef.current] : [];
      try {
        const outcome = await createElementsInTurn([...new Set(paths)].map((filePath) => ({
          block_type: inferBlockType(filePath.split(".").pop()?.toLowerCase() ?? ""),
          title: fileNameToTitle(filePath),
          url: null,
          tags,
          file_path: filePath,
        })));
        if (outcome.created > 0) onBlocksCreatedRef.current();
      } finally {
        setImporting((count) => count - 1);
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    // Drops on the window, as the backend routes them to the tab it shows.
    // The page's own drag events are not heard: the pages of a window share
    // its frame, and AppKit hands a drag to one of them, not always the one
    // shown, so files dropped on a tab used to join the window's first tab
    // (SPEC_TABS.md, В22, 09.10.2026).
    listenPage<TabFileDrag>(TAB_FILE_DRAG_EVENT, (event) => {
      const drag = event.payload;
      if (drag.kind === "enter") {
        fileDragActiveRef.current = drag.paths.length > 0;
        setDragging(fileDragActiveRef.current);
      } else if (drag.kind === "over") {
        if (!fileDragActiveRef.current) return;
        setDragging(true);
      } else if (drag.kind === "drop") {
        const shouldHandleDrop = fileDragActiveRef.current || drag.paths.length > 0;
        fileDragActiveRef.current = false;
        if (shouldHandleDrop) {
          void handleDrop(drag.paths);
        } else {
          setDragging(false);
        }
      } else {
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
      .catch((cause: unknown) => {
        // The page hears no drops: the person sees that a drop does nothing
        // and is told why (Н11).
        if (!disposed) reportActionError("create-elements", createElementsFailureTitle(1), cause);
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

  if (!dragging && importing === 0) return null;

  return (
    <div className="fixed top-8 right-0 bottom-8 left-0 z-50 flex items-center justify-center bg-glass">
      {dragging && (
        <div className="pointer-events-none absolute inset-2 rounded-[4px] border border-dashed border-border dark:border-muted-foreground" />
      )}
      <div className="rounded-1 border border-border bg-background p-6 shadow-lg">
        <p className="text-lg font-semibold text-foreground">
          {dragging ? "Drop files to add" : "Importing..."}
        </p>
        {dragging && (
          <p className="mt-1 text-base text-muted-foreground">
            Images, videos, PDFs, documents
          </p>
        )}
      </div>
    </div>
  );
}
