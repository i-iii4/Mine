import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { copyTextToClipboard } from "@/lib/clipboard";
import { youtubePlayerUrl } from "@/lib/commands";
import type { YoutubeSource } from "@/lib/youtubeSource";

/** Emitted by the shell when a right click lands inside an embedded frame. */
export const SOURCE_VIDEO_CONTEXT_MENU_EVENT = "source-video-context-menu";

type PlayerPage =
  | { status: "pending" }
  | { status: "ready"; url: string }
  | { status: "failed" };

function openSource(url: string) {
  void openUrl(url).catch((error) => console.error("Could not open video source:", error));
}

/** The player loads as soon as the card opens and waits for the user to start it.
 *  It lives in a local page, not in this document: YouTube needs a referrer
 *  that the interface origin cannot send (player error 153).
 *  A right click on it opens the source video menu at the pointer, like any
 *  context menu in Mine: on the poster the page sees the click itself; inside
 *  the player frame the shell reports the point, and it is replayed here as a
 *  `contextmenu` event at that point.
 *  See SPEC_MEDIA_ASSET_ACTIONS.md «Меню видео источника». */
export function YoutubeSourcePlayer({ source, poster, title, onDelete }: {
  source: YoutubeSource;
  poster: string | null;
  title: string;
  onDelete: () => Promise<void>;
}) {
  const [page, setPage] = useState<PlayerPage>({ status: "pending" });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<{ x: number; y: number }>(SOURCE_VIDEO_CONTEXT_MENU_EVENT, (event) => {
      const surface = surfaceRef.current;
      if (cancelled || !surface) return;
      const { x, y } = event.payload;
      const rect = surface.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      surface.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 2,
      }));
    });
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <div className="mb-6" data-youtube-source-player={source.videoId}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={surfaceRef}
            className="relative aspect-video overflow-hidden rounded-1 bg-black"
            data-source-video-surface
            onContextMenu={(event) => event.stopPropagation()}
          >
            {page.status === "ready" ? (
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
                {page.status === "failed" && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <p className="rounded-1 bg-black/70 px-3 py-2 text-sm text-white">This video can't play inside Mine.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent data-source-video-menu>
          <ContextMenuItem onSelect={() => openSource(source.sourceUrl)}>
            <MenuIconSlot />
            Open on YouTube
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyTextToClipboard(source.sourceUrl)}>
            <MenuIconSlot />
            Copy Link
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <MenuIconSlot>
              <Trash2 className="size-3" />
            </MenuIconSlot>
            Delete Media
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <a
        href={source.sourceUrl}
        className="mt-2 inline-block text-sm text-muted-foreground underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault();
          openSource(source.sourceUrl);
        }}
      >Open on YouTube</a>
      <DeleteSourceVideoDialog open={deleteOpen} onOpenChange={setDeleteOpen} onDelete={onDelete} />
    </div>
  );
}

function DeleteSourceVideoDialog({ open, onOpenChange, onDelete }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-delete-source-video-dialog="">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete video from element?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the YouTube link and the poster from this element. The poster file is deleted unless another element uses it. Text and collections stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  setSubmitting(true);
                  setError(null);
                  await onDelete();
                  onOpenChange(false);
                } catch (rawError) {
                  setError(rawError instanceof Error ? rawError.message : String(rawError));
                } finally {
                  setSubmitting(false);
                }
              })();
            }}
          >
            {submitting ? "Deleting..." : "Delete media"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
