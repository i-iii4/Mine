// Search Overlay — поиск по блокам (SPEC_SEARCH_OVERLAY.md).
//
// Modal navigation search: input header, result list with first-match
// snippets on the left, a real read-only card preview of the active result on
// the right. Reuses the existing hybrid-search backend contract
// (`list_grid_blocks(query)` + `search_match`) and the standalone card
// renderer; owns no IPC beyond the debounced search request.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ReadOnlyCardPreview } from "@/components/Card";
import { CardHoverMenu } from "@/components/CardHoverMenu";
import {
  MicroPreviewThumbnail,
  microPreviewFromLightBlock,
} from "@/components/MicroPreviewThumbnail";
import {
  MetadataRow,
  MetadataLinkValue,
  formatMetadataCardKind,
  METADATA_VALUE_BASE_CLASSES,
} from "@/components/MetadataRow";
import { domainFromUrl, isSafeUrl, legacyThumbsRoot } from "@/lib/assets";
import { listGridBlocks } from "@/lib/commands";
import { normalizeSurfaceSearchQuery } from "@/lib/searchQuery";
import { groupByRecency } from "@/lib/recencyBuckets";
import { deriveSearchResultRow } from "@/lib/searchResultRow";
import { renderSearchHighlightedText } from "@/lib/searchHighlight";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import { CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX } from "@/lib/cardTypography";
import { cn } from "@/lib/utils";
import type { LightBlock, TagCount } from "@/types";

/** One request, top results only — refining the query beats paging (SPEC). */
export const SEARCH_OVERLAY_RESULT_LIMIT = 200;

/**
 * Empty-query state shows the freshest saved elements (Р-13/Р-14,
 * SPEC_SEARCH_OVERLAY.md): a springboard to recent work, not a history
 * browser — one or two screens, beyond that the user searches.
 */
export const SEARCH_OVERLAY_RECENT_LIMIT = 20;

/** Same live-typing debounce as the rest of surface search (SPEC_SEARCH.md). */
const SEARCH_OVERLAY_DEBOUNCE_MS = 100;

const snippetLineHeightStyle = {
  lineHeight: `${CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX}px`,
} as const;

function searchOverlayOptionDomId(blockId: number): string {
  return `search-overlay-option-${blockId}`;
}

interface SearchOverlayProps {
  open: boolean;
  query: string;
  vaultPath: string;
  thumbsRootPath?: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onOpenBlock: (block: LightBlock) => void;
  /** Lazy collections for the metadata block (existing batched tags command). */
  loadBlockTags?: (slugs: string[]) => Promise<Map<string, string[]>>;
  /** Hover actions on the preview reuse the main-page CardHoverMenu contract. */
  tags?: TagCount[];
  currentTag?: string;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void | Promise<void>;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void | Promise<void>;
  onRequestRename?: (block: LightBlock) => void;
  onRequestDelete?: (slug: string) => void;
}

export function SearchOverlay({
  open,
  query,
  vaultPath,
  thumbsRootPath,
  onQueryChange,
  onClose,
  onOpenBlock,
  loadBlockTags,
  tags = [],
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
}: SearchOverlayProps) {
  const [results, setResults] = useState<LightBlock[] | null>(null);
  const [totalBlocks, setTotalBlocks] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Collections for the metadata block: lazy per active row, cached per slug,
  // invalidated together with the result set on vault mutations.
  const [tagsBySlug, setTagsBySlug] = useState<Map<string, string[]>>(new Map());

  const inputRef = useRef<HTMLInputElement>(null);
  const requestSequenceRef = useRef(0);
  // Pointer ownership starts only after a real pointermove with new
  // coordinates, so keyboard scrolling under a resting cursor does not steal
  // the active row (CollectionPicker contract).
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const normalizedQuery = normalizeSurfaceSearchQuery(query);

  // searchQuery === null → recent mode: the same grid contract without a
  // query returns the canonical saved_at-DESC order (the feed's first page).
  const runSearch = useCallback(
    (searchQuery: string | null, options: { preserveActive: boolean }) => {
      const sequence = ++requestSequenceRef.current;
      void listGridBlocks(
        undefined,
        0,
        searchQuery === null ? SEARCH_OVERLAY_RECENT_LIMIT : SEARCH_OVERLAY_RESULT_LIMIT,
        searchQuery ?? undefined,
      )
        .then((grid) => {
          if (requestSequenceRef.current !== sequence) return;
          setResults((previous) => {
            if (options.preserveActive) {
              // Silent refresh (vault mutated): keep the user's place — follow
              // the active slug into the new result set, or clamp the index
              // when that card is gone (e.g. it was just deleted).
              setActiveIndex((index) => {
                const activeSlugBefore = previous?.[index]?.slug ?? null;
                const followed = activeSlugBefore
                  ? grid.blocks.findIndex((candidate) => candidate.slug === activeSlugBefore)
                  : -1;
                if (followed >= 0) return followed;
                return Math.min(index, Math.max(0, grid.blocks.length - 1));
              });
            } else {
              setActiveIndex(0);
            }
            return grid.blocks;
          });
          setTotalBlocks(grid.total_blocks);
        })
        .catch((error) => {
          if (requestSequenceRef.current !== sequence) return;
          console.error("Search overlay query failed:", error);
        });
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (!normalizedQuery) {
      // Recent mode loads immediately: the debounce exists for the typing
      // race, a static list has nothing to wait for (Р-16).
      setActiveIndex(0);
      runSearch(null, { preserveActive: false });
      return;
    }
    const timer = window.setTimeout(() => {
      runSearch(normalizedQuery, { preserveActive: false });
    }, SEARCH_OVERLAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open, runSearch]);

  // The result set is overlay-owned state, so vault mutations (delete, rename,
  // clipper saves, watcher events) must re-run the active query — including
  // recent mode, which is just the empty query. App dispatches
  // "vault-refreshed" after every fresh grid snapshot — the same invalidation
  // signal, replayed here without debounce.
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      // Cached collections may be stale after the mutation too.
      setTagsBySlug(new Map());
      runSearch(normalizedQuery || null, { preserveActive: true });
    };
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [normalizedQuery, open, runSearch]);

  // Optimistic delete: App announces a confirmed delete before the IPC and
  // snapshot reload finish, so the row vanishes the moment the user confirms.
  // The subsequent "vault-refreshed" re-runs the query and settles the truth.
  useEffect(() => {
    if (!open) return;
    const handler = (event: Event) => {
      const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
      if (!slug) return;
      setResults((previous) => {
        if (!previous?.some((candidate) => candidate.slug === slug)) return previous;
        const next = previous.filter((candidate) => candidate.slug !== slug);
        setActiveIndex((index) => {
          const activeSlugBefore = previous[index]?.slug ?? null;
          const followed = activeSlugBefore
            ? next.findIndex((candidate) => candidate.slug === activeSlugBefore)
            : -1;
          if (followed >= 0) return followed;
          return Math.min(index, Math.max(0, next.length - 1));
        });
        setTotalBlocks((total) => (total === null ? total : Math.max(0, total - 1)));
        return next;
      });
    };
    window.addEventListener("block-deleted", handler);
    return () => window.removeEventListener("block-deleted", handler);
  }, [open]);

  const resolvedThumbsRoot = useMemo(
    () => thumbsRootPath ?? legacyThumbsRoot(vaultPath),
    [thumbsRootPath, vaultPath],
  );

  const rows = useMemo(
    () => (results ?? []).map((block) => ({
      block,
      row: deriveSearchResultRow(block),
      preview: microPreviewFromLightBlock(block, resolvedThumbsRoot),
    })),
    [resolvedThumbsRoot, results],
  );

  // Recent mode groups rows into dynamic date sections (Today · Yesterday ·
  // Past 7 days · …). Rows keep their flat index — keyboard navigation and
  // the active row are blind to section boundaries. Search results stay
  // ungrouped: there the order is relevance, not time.
  const recentGroups = useMemo(() => {
    if (normalizedQuery.length > 0) return null;
    const indexed = rows.map((entry, index) => ({ ...entry, index }));
    return groupByRecency(indexed, (entry) => entry.block.saved_at, new Date());
  }, [normalizedQuery, rows]);

  const activeBlock = results?.[activeIndex] ?? null;

  // Keep the keyboard-active row visible.
  useEffect(() => {
    if (!activeBlock) return;
    document
      .getElementById(searchOverlayOptionDomId(activeBlock.id))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeBlock]);

  const activeSlug = activeBlock?.slug ?? null;
  useEffect(() => {
    if (!open || !activeSlug || !loadBlockTags) return;
    if (tagsBySlug.has(activeSlug)) return;
    let cancelled = false;
    void loadBlockTags([activeSlug])
      .then((loaded) => {
        if (cancelled) return;
        const tags = loaded.get(activeSlug);
        if (!tags) return;
        setTagsBySlug((current) => {
          const next = new Map(current);
          next.set(activeSlug, tags);
          return next;
        });
      })
      .catch((error) => {
        console.error("Search overlay tags load failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSlug, loadBlockTags, open, tagsBySlug]);

  const activeTags = activeSlug ? tagsBySlug.get(activeSlug) ?? null : null;

  // Optimistic local membership: the Collections row and the picker reflect
  // the toggle immediately; App invalidates its snapshots in the background.
  const applyTagsDelta = useCallback(
    (slug: string, tag: string, connected: boolean) => {
      setTagsBySlug((current) => {
        const existing = current.get(slug) ?? [];
        const next = new Map(current);
        next.set(
          slug,
          connected
            ? existing.includes(tag) ? existing : [...existing, tag]
            : existing.filter((t) => t !== tag),
        );
        return next;
      });
    },
    [],
  );

  const handleToggleTag = useCallback(
    (slug: string, tag: string, hasTag: boolean) => {
      applyTagsDelta(slug, tag, !hasTag);
      void onToggleTag?.(slug, tag, hasTag);
    },
    [applyTagsDelta, onToggleTag],
  );

  const handleCreateAndAssign = useCallback(
    (tag: string, blockSlug: string) => {
      applyTagsDelta(blockSlug, tag, true);
      void onCreateAndAssign?.(tag, blockSlug);
    },
    [applyTagsDelta, onCreateAndAssign],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      if (!results || results.length === 0) return;
      setActiveIndex((current) =>
        Math.min(results.length - 1, Math.max(0, current + delta)),
      );
    },
    [results],
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // Modified arrows/Enter stay global-shortcut candidates (system rule).
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActiveIndex(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActiveIndex(-1);
        return;
      }
      if (event.key === "Enter" && activeBlock) {
        event.preventDefault();
        onOpenBlock(activeBlock);
      }
    },
    [activeBlock, moveActiveIndex, onOpenBlock],
  );

  const handleRowPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
      const last = lastPointerRef.current;
      if (last && last.x === event.clientX && last.y === event.clientY) return;
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setActiveIndex(index);
    },
    [],
  );

  const handleClear = useCallback(() => {
    onQueryChange("");
    inputRef.current?.focus();
  }, [onQueryChange]);

  const isRecentMode = normalizedQuery.length === 0;
  const showCount = !isRecentMode && totalBlocks !== null;
  const showNoResults = !isRecentMode && results !== null && results.length === 0;

  // One row template for both modes; `index` is always the flat results
  // index, so the active row and arrow keys ignore section grouping.
  const renderResultRow = (
    { block, row, preview }: (typeof rows)[number],
    index: number,
  ) => (
    <div
      key={block.id}
      id={searchOverlayOptionDomId(block.id)}
      role="option"
      aria-selected={index === activeIndex}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-1 px-2 py-1.5",
        index === activeIndex && "bg-active",
      )}
      onPointerMove={(event) => handleRowPointerMove(event, index)}
      onClick={() => onOpenBlock(block)}
    >
      <div
        aria-hidden="true"
        className="size-8 shrink-0 overflow-hidden bg-component-fill"
      >
        <MicroPreviewThumbnail
          preview={preview}
          loading="lazy"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-foreground">
          {renderSearchHighlightedText(row.title, row.titleMatch)}
        </p>
        {row.snippet && (
          <p
            className="mt-0.5 line-clamp-1 text-sm text-muted-foreground"
            style={snippetLineHeightStyle}
          >
            {renderSearchHighlightedText(row.snippet, row.snippetMatch)}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        className={cn(
          "left-[50%] top-[12vh] translate-y-0",
          "flex h-[min(640px,76vh)] w-[min(960px,calc(100vw-4rem))] max-w-none flex-col sm:max-w-none",
          "gap-0 overflow-hidden bg-popover p-0",
          "shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]",
        )}
        data-search-overlay
      >
        <DialogTitle className="sr-only">Search elements</DialogTitle>

        <div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
          <Input
            ref={inputRef}
            variant="ghost"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search elements…"
            className="h-8 min-w-0 flex-1 rounded-0 px-2"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="search-overlay-listbox"
            aria-activedescendant={
              activeBlock ? searchOverlayOptionDomId(activeBlock.id) : undefined
            }
            {...SEARCH_INPUT_SUPPRESSION_PROPS}
          />
          {showCount && (
            <span className="shrink-0 px-1 text-sm text-tertiary-foreground">
              {totalBlocks}
            </span>
          )}
          {query.length > 0 && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={handleClear}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-1 text-muted-foreground hover:bg-component-fill-hover hover:text-foreground focus-visible:bg-component-fill-hover focus-visible:text-foreground focus-visible:outline-none"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <div
            id="search-overlay-listbox"
            role="listbox"
            aria-label="Search results"
            className="min-w-0 flex-1 overflow-y-auto p-1"
          >
            {showNoResults && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No results
              </div>
            )}
            {recentGroups
              ? recentGroups.map((group) => (
                  <div key={group.label} role="presentation">
                    {/* Dynamic date sections (Notion convention): the label
                        is derived from saved_at, never typed in. */}
                    <div
                      role="presentation"
                      className="px-2 pb-1 pt-2 text-sm text-muted-foreground"
                      data-search-overlay-recent-label=""
                    >
                      {group.label}
                    </div>
                    {group.items.map(({ block, row, preview, index }) =>
                      renderResultRow({ block, row, preview }, index),
                    )}
                  </div>
                ))
              : rows.map((entry, index) => renderResultRow(entry, index))}
          </div>

          {/* Two zones: the card (micro preview — one uniform template for
              every block type, media inside the card padding, never
              full-bleed; accent-toned) and the metadata block — bare
              MetadataRow list, no card chrome of its own. */}
          <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
            {activeBlock && (
              <>
                <div
                  role="button"
                  tabIndex={-1}
                  aria-label="Open element"
                  className="group relative cursor-pointer"
                  onClick={() => onOpenBlock(activeBlock)}
                  data-search-overlay-preview
                >
                  <ReadOnlyCardPreview
                    block={activeBlock}
                    vaultPath={vaultPath}
                    thumbsRootPath={thumbsRootPath}
                    width={288}
                    previewMode="micro"
                    shadow="none"
                    className="bg-accent"
                  />
                  {/* The real main-page hover menu — More (top-right) plus
                      Source/Connect (bottom row), revealed on hover. */}
                  <CardHoverMenu
                    block={activeBlock}
                    vaultPath={vaultPath}
                    tags={tags}
                    currentTag={currentTag}
                    onToggleTag={handleToggleTag}
                    onCreateAndAssign={handleCreateAndAssign}
                    onRequestRename={onRequestRename ?? (() => {})}
                    onRequestDelete={onRequestDelete ?? (() => {})}
                  />
                </div>
                <div
                  className="shrink-0"
                  data-search-overlay-metadata
                >
                  <MetadataRow label="Date">
                    <span className={cn(METADATA_VALUE_BASE_CLASSES, "truncate")}>
                      {new Date(activeBlock.saved_at).toLocaleDateString("ru-RU", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </MetadataRow>
                  <MetadataRow label="Type">
                    <span className={cn(METADATA_VALUE_BASE_CLASSES, "truncate")}>
                      {formatMetadataCardKind(activeBlock.card_kind)}
                    </span>
                  </MetadataRow>
                  {activeBlock.url && isSafeUrl(activeBlock.url) && domainFromUrl(activeBlock.url) && (
                    <MetadataRow label="Source">
                      <MetadataLinkValue
                        value={domainFromUrl(activeBlock.url)}
                        onClick={() => void openUrl(activeBlock.url!)}
                      />
                    </MetadataRow>
                  )}
                  {activeBlock.author && (
                    <MetadataRow label="Author">
                      <span className={cn(METADATA_VALUE_BASE_CLASSES, "truncate")}>
                        {activeBlock.author}
                      </span>
                    </MetadataRow>
                  )}
                  {activeTags && activeTags.length > 0 && (
                    <MetadataRow label="Collections">
                      <span className={cn(METADATA_VALUE_BASE_CLASSES, "whitespace-normal")}>
                        {activeTags.join(", ")}
                      </span>
                    </MetadataRow>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
