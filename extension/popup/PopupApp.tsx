import { useState, useEffect, useCallback } from "react";
import { useClipperState } from "./hooks/useClipperState";
import { TypeSwitcher } from "./components/TypeSwitcher";
import { ChannelList } from "./components/ChannelList";
import { SaveButton } from "./components/SaveButton";
import { StatusBar } from "./components/StatusBar";

export function PopupApp() {
  const clipper = useClipperState();

  const [status, setStatus] = useState<{ message: string; type: "success" | "error" } | null>(
    null,
  );

  // Cmd+Enter to save, Esc to close
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        window.close();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const handleSave = useCallback(async () => {
    const result = await clipper.save();
    if (!result) return;
    if (result.ok) {
      setStatus({ message: "Saved!", type: "success" });
      setTimeout(() => window.close(), 1200);
    } else {
      setStatus({ message: result.error ?? "Failed to save", type: "error" });
    }
  }, [clipper.save]);

  if (clipper.state === "loading") {
    return <LoadingState />;
  }

  if (clipper.state === "error") {
    return <ErrorState message={clipper.error ?? "Unknown error"} />;
  }

  const { metadata } = clipper;
  const previewText = getPreviewText(clipper);
  const ogImage = clipper.currentType === "image"
    ? metadata?.imageToSave ?? metadata?.image ?? null
    : metadata?.image ?? null;

  return (
    <div className="flex h-full flex-col p-3">
      <div className="shrink-0 space-y-2">
        {metadata?.detectedType !== "image" && (
          <TypeSwitcher current={clipper.currentType} onChange={clipper.setCurrentType} />
        )}

        {clipper.currentType === "link" && (
          <div className="space-y-1.5 rounded-1 border border-border p-2">
            {ogImage && (
              <div className="relative max-h-[120px] overflow-hidden rounded-1">
                <img src={ogImage} alt="" className="block max-h-[120px] w-full object-cover" />
                {metadata?.detectedType === "video" && <PlayOverlay />}
              </div>
            )}
            <p className="truncate text-sm font-semibold">{clipper.title}</p>
            {metadata?.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">{metadata.description}</p>
            )}
            <p className="truncate text-sm text-tertiary-foreground">{metadata?.url}</p>
          </div>
        )}

        {clipper.currentType === "content" && metadata?.detectedType === "video" && (
          <div className="space-y-1.5 rounded-1 border border-border p-2">
            {ogImage && (
              <div className="relative max-h-[120px] overflow-hidden rounded-1">
                <img src={ogImage} alt="" className="block max-h-[120px] w-full object-cover" />
                <PlayOverlay />
              </div>
            )}
            <p className="truncate text-sm font-semibold">{clipper.title}</p>
            <p className="text-sm text-muted-foreground">Transcript not available</p>
          </div>
        )}

        {clipper.currentType === "content" && metadata?.detectedType !== "video" && (
          <div className="space-y-1.5 rounded-1 border border-border p-2">
            <p className="truncate text-sm font-semibold">{clipper.title}</p>
            <div className="max-h-[200px] overflow-y-auto">
              {clipper.articleData?.html ? (
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: clipper.articleData.html }}
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {previewText || metadata?.description || "No content extracted"}
                </p>
              )}
            </div>
          </div>
        )}

        {clipper.currentType === "image" && ogImage && (
          <div className="max-h-[160px] overflow-hidden rounded-1">
            <img src={ogImage} alt="" className="block max-h-[160px] w-full object-cover" />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden py-2">
        <ChannelList
          channels={clipper.channels}
          selectedTags={clipper.selectedTags}
          recentTags={clipper.recentTags}
          onToggle={clipper.toggleTag}
          onCreate={clipper.createChannel}
        />
      </div>

      <div className="shrink-0 space-y-2 border-t border-border pt-2">
        <SaveButton
          count={clipper.selectedTags.length}
          saving={clipper.saving}
          onClick={handleSave}
        />
        {status && <StatusBar message={status.message} type={status.type} />}
      </div>
    </div>
  );
}

// --- Helpers ---

function LoadingState() {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
      <div className="size-4 animate-spin rounded-round border-[1.5px] border-border border-t-foreground" />
      <p className="text-sm">Loading...</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-8 items-center justify-center rounded-1 border border-destructive text-base font-semibold text-destructive">
        !
      </div>
      <p className="max-w-[280px] text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function PlayOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-1 bg-black/50 text-white">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2.5v11l10-5.5L4 2.5z" />
        </svg>
      </div>
    </div>
  );
}

function getPreviewText(clipper: ReturnType<typeof useClipperState>): string | null {
  if (clipper.currentType !== "content") return null;
  const { metadata, articleData } = clipper;
  if (!metadata) return null;

  if (metadata.selection?.length > 0) return metadata.selection;
  if (articleData?.content) return articleData.content.slice(0, 1000);
  if (metadata.description) return metadata.description;
  if (metadata.bodyText) return metadata.bodyText.slice(0, 1000);
  return null;
}
