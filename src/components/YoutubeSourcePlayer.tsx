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
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { Progress } from "@/components/ui/progress";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  cancelSourceVideoDownload,
  sourceVideoDownloadStatus,
  startSourceVideoDownload,
  youtubePlayerUrl,
  type SourceVideoDownloadState,
} from "@/lib/commands";
import type { YoutubeSource } from "@/lib/youtubeSource";

/** Emitted by the shell when a right click lands inside an embedded frame. */
export const SOURCE_VIDEO_CONTEXT_MENU_EVENT = "source-video-context-menu";
/** Emitted by the shell as a Download Media job moves on. */
export const SOURCE_VIDEO_DOWNLOAD_EVENT = "source-video-download";

type PlayerPage =
  | { status: "pending" }
  | { status: "ready"; url: string }
  | { status: "failed" };

function openSource(url: string) {
  void openUrl(url).catch((error) => console.error("Could not open video source:", error));
}

function isRunning(download: SourceVideoDownloadState | null) {
  return download?.state === "downloading" || download?.state === "finishing";
}

/** The player loads as soon as the card opens and waits for the user to start it.
 *  It lives in a local page, not in this document: YouTube needs a referrer
 *  that the interface origin cannot send (player error 153).
 *  A right click on it opens the source video menu at the pointer, like any
 *  context menu in Mine: on the poster the page sees the click itself; inside
 *  the player frame the shell reports the point, and it is replayed here as a
 *  `contextmenu` event at that point.
 *  Download Media runs in the shell; this surface shows its progress and, once
 *  the file is in the space, asks the card to reload so the local video takes
 *  over. See SPEC_MEDIA_ASSET_ACTIONS.md «Меню видео источника». */
export function YoutubeSourcePlayer({ slug, source, poster, title, onDelete, onDownloaded }: {
  slug: string;
  source: YoutubeSource;
  poster: string | null;
  title: string;
  onDelete: () => Promise<void>;
  onDownloaded: () => Promise<void>;
}) {
  const [page, setPage] = useState<PlayerPage>({ status: "pending" });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [download, setDownload] = useState<SourceVideoDownloadState | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const downloadedRef = useRef(onDownloaded);
  downloadedRef.current = onDownloaded;

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

  // A download keeps running when the card closes; reopening it shows where it is.
  useEffect(() => {
    let cancelled = false;
    setDownload(null);
    sourceVideoDownloadStatus(slug).then(
      (status) => { if (!cancelled && isRunning(status)) setDownload(status); },
      (error: unknown) => console.error("Could not read the download state:", error),
    );
    const unlisten = listen<SourceVideoDownloadState & { slug: string }>(SOURCE_VIDEO_DOWNLOAD_EVENT, (event) => {
      if (cancelled || event.payload.slug !== slug) return;
      const { slug: _slug, ...state } = event.payload;
      setDownload(state);
      if (state.state === "done") {
        void downloadedRef.current().catch((error) => console.error("Could not reload the card:", error));
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop());
    };
  }, [slug]);

  const running = isRunning(download);
  const startDownload = () => {
    setDownload({ state: "downloading", percent: 0 });
    startSourceVideoDownload(slug, source.sourceUrl).catch((error: unknown) => {
      setDownload({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    });
  };

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
            Open Original
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyTextToClipboard(source.sourceUrl)}>
            <MenuIconSlot />
            Copy Link
          </ContextMenuItem>
          <ContextMenuItem disabled={running} onSelect={startDownload}>
            <MenuIconSlot />
            Download Media
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <MenuIconSlot>
              <Trash2 className="size-3" />
            </MenuIconSlot>
            Delete Embed
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <SourceVideoDownloadRow
        download={download}
        onCancel={() => {
          void cancelSourceVideoDownload(slug).catch((error) => console.error("Could not cancel the download:", error));
        }}
      />
      <a
        href={source.sourceUrl}
        className="mt-2 inline-block text-sm text-muted-foreground underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault();
          openSource(source.sourceUrl);
        }}
      >Open Original</a>
      <DeleteSourceVideoDialog open={deleteOpen} onOpenChange={setDeleteOpen} onDelete={onDelete} />
    </div>
  );
}

/** Progress of Download Media under the player, never over it: the video
 *  stays watchable while it downloads. */
function SourceVideoDownloadRow({ download, onCancel }: {
  download: SourceVideoDownloadState | null;
  onCancel: () => void;
}) {
  if (!download || download.state === "done" || download.state === "cancelled") return null;
  if (download.state === "failed") {
    return (
      <p className="mt-2 text-sm text-destructive" data-source-video-download="failed">
        Download failed: {download.message}
      </p>
    );
  }
  const label = download.state === "finishing" ? "Joining video and sound…" : `Downloading ${download.percent}%`;
  return (
    <div className="mt-2 flex items-center gap-3" data-source-video-download={download.state}>
      <Progress
        value={download.state === "finishing" ? 100 : download.percent}
        className="flex-1"
        aria-label="Download progress"
      />
      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{label}</span>
      {download.state === "downloading" && (
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      )}
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
          <AlertDialogTitle>Delete embed from element?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the embedded video and its poster from this element. The poster file is deleted unless another element uses it. Text and collections stay.
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
            {submitting ? "Deleting..." : "Delete embed"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
