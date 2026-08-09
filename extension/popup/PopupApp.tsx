import { useState, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownUrl } from "@/lib/markdownUrl";
import { PlayBadge } from "@/components/PlayBadge";
import { useClipperState } from "./hooks/useClipperState";
import { resolveContentBody } from "./lib/resolveContentBody";
import { TypeSwitcher } from "./components/TypeSwitcher";
import { ChannelList } from "./components/ChannelList";
import { SaveButton } from "./components/SaveButton";
import { ScreenshotPreview } from "./components/ScreenshotPreview";
import { VaultSelect } from "./components/VaultSelect";
import { emptyContentMessage } from "./lib/articleExtractionState";
import { buildEmbeddedVideoPreviewMap, isVideoUrl, videoPreviewKey } from "./lib/videoPreview";

function VideoPosterPreview({
  posterUrl,
  title,
}: {
  posterUrl: string | null;
  title: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-1 bg-accent" aria-label={title}>
      {posterUrl ? (
        <img
          src={posterUrl}
          alt=""
          loading="lazy"
          className="mx-auto block max-h-[120px] w-auto max-w-full rounded-1 object-contain"
        />
      ) : (
        <div className="h-[120px] w-full bg-muted" />
      )}
      {/* The same play affordance the feed draws over still posters — a
          clipper-only badge variant was a contract violation. */}
      <PlayBadge />
    </div>
  );
}

function TypeRow({
  current,
  onChange,
}: {
  current: Parameters<typeof TypeSwitcher>[0]["current"];
  onChange: Parameters<typeof TypeSwitcher>[0]["onChange"];
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-chrome px-4">
      <span className="text-base text-muted-foreground">Type:</span>
      <TypeSwitcher current={current} onChange={onChange} />
    </div>
  );
}

export function PopupApp() {
  const clipper = useClipperState();

  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    setSaveError(null);
    const result = await clipper.save();
    if (!result) return;
    if (result.ok) {
      setSaved(true);
      setTimeout(closeClipper, 1200);
    } else {
      setSaveError(result.error ?? "Failed to save");
    }
  }, [clipper.save, closeClipper]);

  // Cmd+Enter to save, Esc to close, Tab to cycle Content → Screenshot → Link.
  // Listener on window in CAPTURE phase so page scripts cannot swallow Tab
  // before we see it (apple.com, medium, etc. commonly attach keydown
  // handlers on document/window in bubble phase). In capture phase we get
  // the event first, then decide whether to handle.
  //
  // Activation rule: handle the event only when focus is already inside
  // the clipper overlay (or when the page body itself has focus — i.e. no
  // explicit text-input engagement on the host page). This avoids hijacking
  // Tab navigation when the user is typing in an input on the underlying
  // page. The ergonomic consequence: the moment the overlay is visible and
  // the user has not actively clicked into a page field, Tab cycles clipper
  // tabs — no clicks on the overlay required.
  useEffect(() => {
    // Architectural principle: while the clipper overlay is mounted it is
    // a modal UI — Tab is a clipper shortcut, not page navigation. The
    // ONLY reason to defer Tab to native behavior is when the user is
    // typing inside a text field OWNED BY OVERLAY (title input, channel
    // search). Page-level focus is irrelevant to us: even if apple.com
    // autofocused one of its search fields, Tab while our overlay is
    // visible should cycle clipper tabs.
    //
    // On the detached-popup fallback path (service pages) the overlay
    // host doesn't exist — the entire document IS our UI — and the
    // generic text-field check is correct.
    function activeIsOverlayTextField(): boolean {
      const host = document.querySelector("[data-mine-clipper-overlay]");
      // Walk shadow roots: activeElement retargets to the shadow host,
      // so we descend until we reach the true leaf focused element.
      function drillToLeaf(start: Element | null): Element | null {
        let el = start;
        while (el) {
          const shadow = (el as HTMLElement & {
            shadowRoot?: ShadowRoot | null;
          }).shadowRoot;
          if (shadow?.activeElement) el = shadow.activeElement;
          else return el;
        }
        return null;
      }
      function isText(el: Element | null): boolean {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return true;
        if ((el as HTMLElement).isContentEditable) return true;
        return false;
      }
      if (!host) {
        // Detached-popup path: entire document is ours.
        return isText(drillToLeaf(document.activeElement));
      }
      // Overlay path: defer only if focus is inside our host.
      if (!host.contains(document.activeElement)) return false;
      return isText(drillToLeaf(document.activeElement));
    }
    function hasOpenFloatingLayer(): boolean {
      const host = document.querySelector("[data-mine-clipper-overlay]");
      const scope: ParentNode = (host as HTMLElement & { shadowRoot?: ShadowRoot | null })
        ?.shadowRoot ?? document;
      return scope.querySelector('[data-slot="dropdown-menu-content"]') !== null;
    }
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === "Escape") {
        // Escape climbs the layers, innermost first: a search field clears
        // its query (or blurs), an open dropdown closes itself. This capture
        // listener fires before either of them, so it must stand down while
        // any inner surface still has a claim — otherwise Escape in the
        // space search tears down the whole clipper.
        if (activeIsOverlayTextField()) return;
        if (hasOpenFloatingLayer()) return;
        closeClipper();
        return;
      }
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (activeIsOverlayTextField()) return;
        if (clipper.metadata?.detectedType === "image") return;
        e.preventDefault();
        e.stopPropagation();
        const order = ["content", "screenshot", "link"] as const;
        const idx = order.indexOf(clipper.currentType as typeof order[number]);
        const step = e.shiftKey ? -1 : 1;
        const next =
          order[((idx < 0 ? 0 : idx) + step + order.length) % order.length]!;
        clipper.setCurrentType(next);
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [handleSave, closeClipper, clipper.currentType, clipper.setCurrentType, clipper.metadata?.detectedType]);

  const { metadata, articleData } = clipper;
  const resolvedBody = resolveContentBody(metadata, articleData);
  const ogImage = clipper.currentType === "image"
    ? metadata?.imageToSave ?? metadata?.image ?? null
    : metadata?.image ?? null;
  const embeddedVideoPreviews = articleData?.embeddedVideos ?? [];
  const embeddedVideoBySrc = useMemo(() => {
    return buildEmbeddedVideoPreviewMap(embeddedVideoPreviews);
  }, [embeddedVideoPreviews]);
  const hasTypeRow = metadata?.detectedType !== "image";

  if (clipper.state === "loading") {
    return <LoadingState />;
  }

  if (clipper.state === "error") {
    return <ErrorState message={clipper.error ?? "Unknown error"} />;
  }

  const footerError = saveError ?? clipper.nativeStatusError;

  return (
    <div className="flex min-h-0 flex-col">
      {clipper.selectedVault && (
        <VaultSelect
          value={clipper.selectedVault}
          options={clipper.knownVaults}
          onChange={clipper.switchVault}
          onReveal={clipper.revealSpace}
          onAddSpace={clipper.addSpace}
          onClose={closeClipper}
        />
      )}

      {hasTypeRow && (
        <TypeRow current={clipper.currentType} onChange={clipper.setCurrentType} />
      )}

      <div className="mine-clipper-body" data-after-type={hasTypeRow ? "true" : "false"}>
        {/* Elastic model: the only elements that compress under a short
            viewport are the preview surfaces themselves — an image scales
            down (object-contain), the article box shrinks onto its own
            scroll. Buttons, the channel picker's quantized list and the save
            stack keep their heights, so nothing overlaps and nothing
            disappears. min-h-0 lets the flex chain pass the squeeze down to
            those elastic boxes. */}
        <div className="mine-clipper-section-stack min-h-0">
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
            <div
              className="max-h-[280px] min-h-24 overflow-y-auto rounded-1 border border-border p-2"
              data-clipper-scrollbar=""
            >
              {metadata?.detectedType === "video" && embeddedVideoPreviews.length === 0 && ogImage && (
                <VideoPosterPreview posterUrl={ogImage} title="Video preview" />
              )}
              {embeddedVideoPreviews.length > 0 && (
                <div className="space-y-1.5">
                  {embeddedVideoPreviews.map((video, index) => (
                    <VideoPosterPreview
                      key={`${video.src ?? video.poster ?? "video"}-${index}`}
                      posterUrl={video.poster ?? ogImage}
                      title={video.title || "Video preview"}
                    />
                  ))}
                </div>
              )}
              {resolvedBody.source === "selection" ? (
                <div className="mt-1.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Selected text · {resolvedBody.text.length} characters
                  </p>
                  <blockquote className="mt-1 border-l-2 border-border pl-2 text-sm italic text-foreground whitespace-pre-wrap">
                    {resolvedBody.text}
                  </blockquote>
                </div>
              ) : clipper.articleExtractionState === "loading" ? (
                <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="size-3 animate-spin rounded-round border-[1.5px] border-border border-t-foreground" />
                  {metadata?.detectedType === "video" ? "Loading transcript..." : "Extracting content..."}
                </div>
              ) : resolvedBody.text ? (
                <div className="mine-clipper-article-preview prose prose-sm mt-1.5 max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    urlTransform={safeMarkdownUrl}
                    components={{
                      img: ({ src, alt, ...props }) => {
                        // An extractor that registered this source already knows
                        // it is video, whatever the URL looks like — that answer
                        // outranks guessing from the extension, which API-style
                        // URLs (a method name, not a file type) do not carry.
                        if (embeddedVideoBySrc.has(videoPreviewKey(src) ?? "")) return null;
                        if (isVideoUrl(src)) {
                          return (
                            <VideoPosterPreview
                              posterUrl={ogImage}
                              title={alt ? `Video preview: ${alt}` : "Video preview"}
                            />
                          );
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
                  {clipper.articleExtractionState === "empty" || clipper.articleExtractionState === "failed"
                    ? emptyContentMessage(metadata, clipper.articleExtractionState)
                    : metadata?.description || "No content extracted"}
                </p>
              )}
            </div>
          )}

          {clipper.currentType === "image" && ogImage && (
            <div className="flex min-h-24 shrink justify-center overflow-hidden rounded-1 border border-border bg-accent">
              <img
                src={ogImage}
                alt=""
                className="block max-h-[220px] min-h-0 w-auto max-w-full rounded-1 object-contain"
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
          onToggle={clipper.toggleTag}
          onCreate={clipper.createChannel}
        />

        <div className="mine-clipper-section-stack shrink-0">
          {/* The error sits above the button: below it, a short viewport
              would push the one line that explains the failure off screen. */}
          {footerError && !saved && (
            <p className="text-sm text-destructive" data-clipper-save-error="">
              {footerError}
            </p>
          )}
          <SaveButton
            count={clipper.selectedTags.length}
            state={saved ? "saved" : clipper.saving ? "saving" : "idle"}
            onClick={handleSave}
          />
        </div>
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
