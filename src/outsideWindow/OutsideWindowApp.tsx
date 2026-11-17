// The outside window's page (SPEC_OUTSIDE_WINDOW.md, НО1, НО6): it draws the
// hover preview window of a showing a source page opened outside its app
// window, with the same component the source draws it with inside.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { HoverPreviewWindowSurface } from "@/components/HoverPreviewWindow";
import { DragCardStackPreview, ReadOnlyCardPreview } from "@/components/Card";
import { CARD_PEEK_PREPARE_MAX_MS } from "@/lib/cardPeek";
import { CollectionHoverPreview, type CollectionPreviewContent } from "@/components/CollectionHoverPreview";
import { reloadFeedDisplay } from "@/lib/feedDisplay";
import { HOVER_PREVIEW_WINDOW_WIDTH_PX } from "@/lib/hoverPreviewPresenter";
import { OUTSIDE_TO_PAGE_EVENT, reportOutsideWindow } from "@/lib/outsideWindowCommands";
import { listenPage } from "@/lib/pageEvents";
import { SETTINGS_CHANGED_EVENT, adoptSettingsChange, type SettingsChangedPayload } from "@/lib/settingsChanged";
import { applyMenuPanelAppearance } from "@/menuPanel/appearance";
import type { OutsideCollection, OutsideLook, OutsidePageMessage, OutsidePageReport, PreviewContent } from "@/types";
import { OutsidePreviewPage, type OutsideDrag } from "./outsidePreviewPage";

const LOG = "Outside window";

function logFailure(what: string, error: unknown): void {
  console.error(`${LOG}: ${what}:`, error);
}

function tellBackend(report: OutsidePageReport): void {
  reportOutsideWindow(report).catch((error: unknown) => logFailure(`the report ${report.kind} did not reach the backend`, error));
}

/** The backend's collection as the window's content (С7.12). */
export function collectionContent(collection: OutsideCollection): CollectionPreviewContent {
  return {
    kind: "collection",
    rowKey: collection.row_key,
    name: collection.name,
    count: collection.count,
    cards: collection.cards.map((tile) => ({
      slug: tile.slug ?? undefined,
      url: tile.url,
      text: tile.text,
      hasThumb: tile.has_thumb,
    })),
    placeholders: collection.placeholders,
  };
}

/** What a showing's window holds, drawn as the source draws it. */
export function OutsideContent({ content, look }: { content: PreviewContent; look: OutsideLook }) {
  if (content.kind === "collection") {
    return <CollectionHoverPreview content={collectionContent(content.collection)} width={HOVER_PREVIEW_WINDOW_WIDTH_PX} />;
  }
  return (
    <ReadOnlyCardPreview
      block={content.block}
      vaultPath={look.vault_path}
      thumbsRootPath={look.thumbs_root_path ?? undefined}
      thumbVersion={content.thumb_version ?? undefined}
      width={HOVER_PREVIEW_WINDOW_WIDTH_PX}
    />
  );
}

/** Until the pictures in `element` are decoded, `CARD_PEEK_PREPARE_MAX_MS` at
 *  most: the wait of the preview window's cards (SPEC_CARD_STATES.md, С7.11). */
function decoded(element: HTMLElement): Promise<unknown> {
  const decodes = Array.from(element.querySelectorAll("img"), (image) => (
    typeof image.decode === "function" ? image.decode() : undefined
  ));
  return Promise.race([
    Promise.allSettled(decodes),
    new Promise((resolve) => window.setTimeout(resolve, CARD_PEEK_PREPARE_MAX_MS)),
  ]);
}

/** The dragged card where the backend's frame has its front card (ПК1); the
 *  window moves, the card on its page does not. */
function OutsideDragCard({ drag, onDrawn }: { drag: OutsideDrag; onDrawn: (id: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { blocks, thumb_versions: versions, look } = drag.stack;
  const thumbVersions = useMemo(() => {
    const known = new Map<string, number>();
    blocks.forEach((block, index) => {
      const version = versions[index];
      if (version !== null && version !== undefined) known.set(block.slug, version);
    });
    return known;
  }, [blocks, versions]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let current = true;
    void decoded(element).then(() => {
      if (current) onDrawn(drag.id);
    });
    return () => {
      current = false;
    };
  }, [drag.id, onDrawn]);
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed"
      style={{ left: drag.at.x, top: drag.at.y }}
      data-outside-drag=""
    >
      <DragCardStackPreview
        blocks={blocks}
        vaultPath={look.vault_path}
        thumbsRootPath={look.thumbs_root_path ?? undefined}
        thumbVersions={thumbVersions}
      />
    </div>
  );
}

export function OutsideWindowApp({ tell = tellBackend }: { tell?: (report: OutsidePageReport) => void }) {
  const [page] = useState(() => new OutsidePreviewPage(tell));
  const session = useSyncExternalStore(page.subscribe, page.current, page.current);
  const drag = useSyncExternalStore(page.subscribe, page.drag, page.drag);
  const dragDrawn = useCallback((id: number) => page.dragDrawn(id), [page]);

  useEffect(() => {
    const subscriptions = [
      listenPage<OutsidePageMessage>(OUTSIDE_TO_PAGE_EVENT, (event) => page.hear(event.payload)),
      listenPage<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
        adoptSettingsChange(event.payload);
        applyMenuPanelAppearance();
        reloadFeedDisplay();
      }),
    ];
    // Every subscription stands, and the page has drawn its rest, before the
    // backend hears it is ready and checks the window for clearness.
    void Promise.all(subscriptions).then(
      () => requestAnimationFrame(() => requestAnimationFrame(() => tell({ kind: "ready" }))),
      (error: unknown) => logFailure("the page could not listen", error),
    );
    return () => {
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten(), () => undefined);
      page.dispose();
    };
  }, [page, tell]);

  const look = session?.look;
  const renderContent = useCallback(
    (content: PreviewContent) => (look ? <OutsideContent content={content} look={look} /> : null),
    [look],
  );

  if (drag) return <OutsideDragCard key={drag.id} drag={drag} onDrawn={dragDrawn} />;
  if (!session) return null;
  return (
    <HoverPreviewWindowSurface
      key={session.id}
      controller={session.presenter}
      renderCard={renderContent}
      attribute="data-outside-preview"
    />
  );
}
