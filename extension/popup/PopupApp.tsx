import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useClipperState } from "./hooks/useClipperState";
import { resolveContentBody } from "./lib/resolveContentBody";
import { TypeSwitcher } from "./components/TypeSwitcher";
import { ChannelList } from "./components/ChannelList";
import { SaveButton } from "./components/SaveButton";
import { ScreenshotPreview } from "./components/ScreenshotPreview";
import { StatusBar } from "./components/StatusBar";
import { VaultSelect } from "./components/VaultSelect";

export function PopupApp() {
  const clipper = useClipperState();

  const [status, setStatus] = useState<{ message: string; type: "success" | "error" } | null>(
    null,
  );

  // Context-aware close: in the overlay (content-script isolated world)
  // `window.close()` would try to close the whole tab because `window`
  // refers to the page's own windowProxy. The overlay entry exposes
  // __mineOverlay.close() which just unmounts the overlay host.
  // In window-entry fallback (detached popup window) __mineOverlay is
  // undefined and window.close() correctly closes the popup window.
  const closeClipper = useCallback(() => {
    const overlay = (globalThis as unknown as {
      __mineOverlay?: { close: () => void };
    }).__mineOverlay;
    if (overlay) overlay.close();
    else window.close();
  }, []);

  const handleSave = useCallback(async () => {
    const result = await clipper.save();
    if (!result) return;
    if (result.ok) {
      setStatus({ message: "Saved!", type: "success" });
      setTimeout(closeClipper, 1200);
    } else {
      setStatus({ message: result.error ?? "Failed to save", type: "error" });
    }
  }, [clipper.save, closeClipper]);

  // Cmd+Enter to save, Esc to close
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        closeClipper();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleSave, closeClipper]);

  if (clipper.state === "loading") {
    return <LoadingState />;
  }

  if (clipper.state === "error") {
    return <ErrorState message={clipper.error ?? "Unknown error"} />;
  }

  const { metadata, articleData } = clipper;
  const resolvedBody = resolveContentBody(metadata, articleData);
  const ogImage = clipper.currentType === "image"
    ? metadata?.imageToSave ?? metadata?.image ?? null
    : metadata?.image ?? null;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="space-y-2">
        {clipper.knownVaults.length > 1 && (
          <VaultSelect
            value={clipper.selectedVault}
            options={clipper.knownVaults}
            onChange={clipper.switchVault}
          />
        )}

        {metadata?.detectedType !== "image" && (
          <TypeSwitcher current={clipper.currentType} onChange={clipper.setCurrentType} />
        )}

        {clipper.currentType === "link" && (
          <div className="space-y-1.5 rounded-1 border border-border p-2">
            {ogImage && (
              <div className="rounded-1 bg-accent">
                <img
                  src={ogImage}
                  alt=""
                  className="mx-auto block max-h-[120px] w-auto max-w-full rounded-1 object-contain"
                />
              </div>
            )}
            <p className="truncate text-sm font-semibold">{clipper.title}</p>
            {metadata?.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">{metadata.description}</p>
            )}
            <p className="truncate text-sm text-tertiary-foreground">{metadata?.url}</p>
          </div>
        )}

        {clipper.currentType === "content" && (
          <div className="max-h-[280px] overflow-y-auto rounded-1 border border-border p-2">
            {metadata?.detectedType === "video" && ogImage && (
              <div className="rounded-1 bg-accent">
                <img
                  src={ogImage}
                  alt=""
                  className="mx-auto block max-h-[120px] w-auto max-w-full rounded-1 object-contain"
                />
              </div>
            )}
            <p className="mt-1.5 truncate text-sm font-semibold">{clipper.title}</p>
            {resolvedBody.source === "selection" ? (
              <div className="mt-1.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Selected text · {resolvedBody.text.length} characters
                </p>
                <blockquote className="mt-1 border-l-2 border-border pl-2 text-sm italic text-foreground whitespace-pre-wrap">
                  {resolvedBody.text}
                </blockquote>
              </div>
            ) : clipper.articleLoading ? (
              <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
                <div className="size-3 animate-spin rounded-round border-[1.5px] border-border border-t-foreground" />
                Loading transcript...
              </div>
            ) : resolvedBody.text ? (
              <div className="prose prose-sm mt-1.5 max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ src, alt, ...props }) => {
                      if (/\.mp4(\?|$)|\.webm(\?|$)/i.test(src ?? "")) {
                        return <video src={src} autoPlay loop muted playsInline />;
                      }
                      return <img src={src} alt={alt ?? ""} loading="lazy" {...props} />;
                    },
                  }}
                >
                  {resolvedBody.text}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="mt-1.5 text-sm text-muted-foreground">
                {metadata?.description || "No content extracted"}
              </p>
            )}
          </div>
        )}

        {clipper.currentType === "image" && ogImage && (
          <div className="rounded-1 border border-border bg-accent">
            <img
              src={ogImage}
              alt=""
              className="mx-auto block max-h-[220px] w-auto max-w-full rounded-1 object-contain"
            />
          </div>
        )}

        {clipper.currentType === "screenshot" && clipper.screenshotDataUrl && (
          <ScreenshotPreview
            dataUrl={clipper.screenshotDataUrl}
            onRetake={clipper.retakeScreenshot}
            onCrop={clipper.startCropMode}
            cropSupported={clipper.cropSupported}
          />
        )}
      </div>

      <ChannelList
        channels={clipper.channels}
        selectedTags={clipper.selectedTags}
        recentTags={clipper.recentTags}
        onToggle={clipper.toggleTag}
        onCreate={clipper.createChannel}
      />

      <div className="space-y-2 border-t border-border pt-2">
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

