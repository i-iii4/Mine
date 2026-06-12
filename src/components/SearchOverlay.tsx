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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ReadOnlyCardPreview } from "@/components/Card";
import {
  MicroPreviewThumbnail,
  microPreviewFromLightBlock,
} from "@/components/MicroPreviewThumbnail";
import { MetadataRow, METADATA_VALUE_BASE_CLASSES } from "@/components/MetadataRow";
import { domainFromUrl, legacyThumbsRoot } from "@/lib/assets";
import { listGridBlocks } from "@/lib/commands";
import { normalizeSurfaceSearchQuery } from "@/lib/searchQuery";
import { deriveSearchResultRow } from "@/lib/searchResultRow";
import { renderSearchHighlightedText } from "@/lib/searchHighlight";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import { CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX } from "@/lib/cardTypography";
import { cn } from "@/lib/utils";
import type { LightBlock } from "@/types";

/** One request, top results only — refining the query beats paging (SPEC). */
export const SEARCH_OVERLAY_RESULT_LIMIT = 200;

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
}: SearchOverlayProps) {
  const [results, setResults] = useState<LightBlock[] | null>(null);
  const [totalBlocks, setTotalBlocks] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestSequenceRef = useRef(0);
  // Pointer ownership starts only after a real pointermove with new
  // coordinates, so keyboard scrolling under a resting cursor does not steal
  // the active row (CollectionPicker contract).
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const normalizedQuery = normalizeSurfaceSearchQuery(query);

  useEffect(() => {
    if (!open) return;
    if (!normalizedQuery) {
      requestSequenceRef.current += 1;
      setResults(null);
      setTotalBlocks(null);
      setActiveIndex(0);
      return;
    }
    const sequence = ++requestSequenceRef.current;
    const timer = window.setTimeout(() => {
      void listGridBlocks(undefined, 0, SEARCH_OVERLAY_RESULT_LIMIT, normalizedQuery)
        .then((grid) => {
          if (requestSequenceRef.current !== sequence) return;
          setResults(grid.blocks);
          setTotalBlocks(grid.total_blocks);
          setActiveIndex(0);
        })
        .catch((error) => {
          if (requestSequenceRef.current !== sequence) return;
          console.error("Search overlay query failed:", error);
        });
    }, SEARCH_OVERLAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open]);

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

  const activeBlock = results?.[activeIndex] ?? null;

  // Keep the keyboard-active row visible.
  useEffect(() => {
    if (!activeBlock) return;
    document
      .getElementById(searchOverlayOptionDomId(activeBlock.id))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeBlock]);

  // Collections for the metadata block: lazy per active row, cached per slug
  // for the overlay session (tags are not part of the LightBlock projection).
  const [tagsBySlug, setTagsBySlug] = useState<Map<string, string[]>>(new Map());
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

  const showCount = normalizedQuery.length > 0 && totalBlocks !== null;
  const showNoResults =
    normalizedQuery.length > 0 && results !== null && results.length === 0;

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
        <DialogTitle className="sr-only">Search cards</DialogTitle>

        <div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
          <Input
            ref={inputRef}
            variant="ghost"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search cards…"
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
            {rows.map(({ block, row, preview }, index) => (
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
                      className="mt-0.5 line-clamp-2 text-sm text-muted-foreground"
                      style={snippetLineHeightStyle}
                    >
                      {renderSearchHighlightedText(row.snippet, row.snippetMatch)}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Two delimited zones: the card (micro preview — one uniform
              template for every block type, media inside the card padding,
              never full-bleed) and the metadata block (Detail metadata-card
              language). */}
          <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
            {activeBlock && (
              <>
                <div
                  role="button"
                  tabIndex={-1}
                  aria-label="Open card"
                  className="cursor-pointer"
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
                  />
                </div>
                <div
                  className="shrink-0 overflow-hidden rounded-1 border border-border bg-accent"
                  data-search-overlay-metadata
                >
                  <div className="px-2 pb-4 pt-4">
                    <MetadataRow label="Date">
                      <span className={cn(METADATA_VALUE_BASE_CLASSES, "truncate")}>
                        {new Date(activeBlock.saved_at).toLocaleDateString("ru-RU", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </MetadataRow>
                    {activeBlock.url && domainFromUrl(activeBlock.url) && (
                      <MetadataRow label="Source">
                        <span className={cn(METADATA_VALUE_BASE_CLASSES, "truncate")}>
                          {domainFromUrl(activeBlock.url)}
                        </span>
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
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
