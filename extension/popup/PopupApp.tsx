import { useState, useEffect, useCallback } from "react";
import { useClipperState } from "./hooks/useClipperState";
import { PreviewCard } from "./components/PreviewCard";
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
  const domain = getDomain(metadata?.url);
  const previewText = getPreviewText(clipper);

  return (
    <div className="space-y-2 p-3">
      <PreviewCard
        title={clipper.title}
        onTitleChange={clipper.setTitle}
        domain={domain}
        thumbnailUrl={getThumbnailUrl(clipper)}
        imagePreviewUrl={
          clipper.currentType === "image"
            ? metadata?.imageToSave ?? metadata?.image ?? null
            : null
        }
      />

      {metadata?.detectedType !== "image" && metadata?.detectedType !== "video" && (
        <TypeSwitcher current={clipper.currentType} onChange={clipper.setCurrentType} />
      )}

      {previewText && (
        <p className="line-clamp-5 whitespace-pre-wrap rounded-1 border border-border p-2 text-sm text-muted-foreground">
          {previewText}
        </p>
      )}

      <ChannelList
        channels={clipper.channels}
        selectedTags={clipper.selectedTags}
        recentTags={clipper.recentTags}
        onToggle={clipper.toggleTag}
        onCreate={clipper.createChannel}
      />

      <SaveButton
        count={clipper.selectedTags.length}
        saving={clipper.saving}
        onClick={handleSave}
      />

      {status && <StatusBar message={status.message} type={status.type} />}
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

function getDomain(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getThumbnailUrl(clipper: ReturnType<typeof useClipperState>): string | null {
  const { metadata, currentType } = clipper;
  if (!metadata) return null;
  if (currentType === "image") return null;
  return metadata.image ?? metadata.favicon ?? null;
}

function getPreviewText(clipper: ReturnType<typeof useClipperState>): string | null {
  if (clipper.currentType !== "content") return null;
  const { metadata, articleData } = clipper;
  if (!metadata) return null;

  let text = "";
  if (metadata.selection?.length > 0) {
    text = metadata.selection;
  } else if (articleData?.content) {
    text = articleData.content.slice(0, 200);
  }
  if (!text) return null;
  return text.length >= 200 ? text + "..." : text;
}
