// Search Overlay — поиск по блокам (SPEC_SEARCH_OVERLAY.md).
//
// Modal navigation search: input header, one-line result rows (file name,
// then the first-match text) on the left, a real read-only card preview of the active result on
// the right. Reuses the existing hybrid-search backend contract
// (`search_grid_blocks` + `search_match`) and the standalone card
// renderer; owns no IPC beyond the debounced search request.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { DropdownMenuPortalContainerProvider } from "@/components/ui/dropdown-menu";
import {
  MicroPreviewThumbnail,
  microPreviewFromLightBlock,
} from "@/components/MicroPreviewThumbnail";
import {
  MetadataRow,
  MetadataLinkValue,
  METADATA_VALUE_BASE_CLASSES,
} from "@/components/MetadataRow";
import { domainFromUrl, isSafeUrl, fallbackThumbsRoot } from "@/lib/assets";
import { listGridBlocks, searchGridBlocks } from "@/lib/commands";
import { normalizeSurfaceSearchQuery } from "@/lib/searchQuery";
import { groupByRecency } from "@/lib/recencyBuckets";
import {
  deriveSearchResultRow,
  windowNameAroundMark,
  type NameWindow,
} from "@/lib/searchResultRow";
import { renderSearchHighlightedText } from "@/lib/searchHighlight";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import { commandById } from "@/lib/commandRegistry";
import {
  SearchResultRowActions,
  searchRowActionsReservePx,
} from "@/components/SearchResultRowActions";
import { cn } from "@/lib/utils";
import { useTopFadeMask } from "@/hooks/useTopFadeMask";
import { TopFadeScrim } from "./TopFadeScrim";
import type { LightBlock, SearchMatch, TagCount } from "@/types";

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

/** One typed character is too noisy for vault-wide body/hybrid search. */
export const SEARCH_OVERLAY_MIN_QUERY_CHARS = 2;

/**
 * A result row is one line (user's decision of 06.10.2026): the file name,
 * then the note's text that does not repeat it, told apart by color alone
 * and a small gap, no separator glyph. The type is the Sidebar collection
 * row's (`font-sans text-base`), so every row has the same height.
 */
const RESULT_LINE_CLASSES = "flex min-w-0 flex-1 items-baseline gap-1 font-sans text-base";

/**
 * With text after it, the name takes what it needs up to three quarters of
 * the line and truncates past that, so the text always starts. Alone, the
 * name takes the whole line.
 */
const RESULT_NAME_SHARE = 0.75;
const resultNameWithTextStyle = { maxWidth: `${RESULT_NAME_SHARE * 100}%` } as const;

/** Canvas widths and the laid-out line round differently by a pixel or so. */
const NAME_FIT_SLACK_PX = 2;

let nameMeasureContext: CanvasRenderingContext2D | null | undefined;

/** Widths in the element's own font, on one shared canvas. */
function measureInFontOf(element: HTMLElement): ((text: string) => number) | null {
  nameMeasureContext ??= document.createElement("canvas").getContext("2d");
  const context = nameMeasureContext;
  if (!context) return null;
  const style = getComputedStyle(element);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (text) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

/**
 * The row's name. When the line cuts the name before its first mark, the
 * name keeps its head and skips to the words that lead up to the mark
 * (`windowNameAroundMark`), so a result never hides why it matched.
 * A name alone on its line stops `endReservePx` short of the line's end
 * while the row's buttons stand there.
 */
function SearchResultName({
  name,
  match,
  withText,
  endReservePx,
}: {
  name: string;
  match: SearchMatch | null;
  withText: boolean;
  endReservePx: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<NameWindow | null>(null);
  const ranges = match && match.excerpt === name && match.ranges.length > 0 ? match.ranges : null;
  const reservePx = withText ? 0 : endReservePx;

  useLayoutEffect(() => {
    const span = ref.current;
    const line = span?.parentElement;
    if (!span || !line || !ranges) {
      setFitted(null);
      return;
    }
    const fit = () => {
      const lineWidth = line.clientWidth;
      const measure = lineWidth > 0 ? measureInFontOf(span) : null;
      if (!measure) {
        setFitted(null);
        return;
      }
      const room = (withText ? lineWidth * RESULT_NAME_SHARE : lineWidth - reservePx) - NAME_FIT_SLACK_PX;
      setFitted(windowNameAroundMark(name, ranges, room, measure));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let observedWidth = line.clientWidth;
    const observer = new ResizeObserver(() => {
      if (line.clientWidth === observedWidth) return;
      observedWidth = line.clientWidth;
      fit();
    });
    observer.observe(line);
    return () => observer.disconnect();
  }, [name, ranges, reservePx, withText]);

  return (
    <span
      ref={ref}
      className="min-w-0 truncate text-foreground"
      style={withText
        ? resultNameWithTextStyle
        : reservePx > 0 ? { maxWidth: `calc(100% - ${reservePx}px)` } : undefined}
      data-search-result-name=""
      data-search-result-name-window={fitted ? "" : undefined}
    >
      {fitted && match
        ? renderSearchHighlightedText(fitted.text, { ...match, excerpt: fitted.text, ranges: fitted.ranges })
        : renderSearchHighlightedText(name, match)}
    </span>
  );
}

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
  /** A result row's commands (Connect, Source, More) are the feed card's. */
  tags?: TagCount[];
  currentTag?: string;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void | Promise<void>;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void | Promise<void>;
  onRequestRename?: (block: LightBlock) => void;
  onRequestDelete?: (slug: string) => void;
  /** Dissolve results into transparency as they scroll up under the query row. */
  scrollEdgeFade?: boolean;
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
  scrollEdgeFade = false,
}: SearchOverlayProps) {
  const [results, setResults] = useState<LightBlock[] | null>(null);
  const [resultHasMore, setResultHasMore] = useState(false);
  const [settledQueryKey, setSettledQueryKey] = useState<string | null>(null);
  // The text whose request failed, with the reason. The error belongs to that
  // text only: typing on hides it, and a later answer replaces it (Г4.3).
  const [failedQuery, setFailedQuery] = useState<{ key: string; message: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Collections for the metadata block: lazy per active row, cached per slug,
  // invalidated together with the result set on vault mutations.
  const [tagsBySlug, setTagsBySlug] = useState<Map<string, string[]>>(new Map());

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsTopFade = useTopFadeMask(undefined, scrollEdgeFade);
  const requestSequenceRef = useRef(0);
  /// The query Enter was pressed for before its results arrived: the first
  /// result of exactly that query opens once it settles (А6.11).
  const pendingOpenRef = useRef<string | null>(null);
  // Pointer ownership starts only after a real pointermove with new
  // coordinates, so keyboard scrolling under a resting cursor does not steal
  // the active row (CollectionPicker contract).
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  // The row the pointer is on: its commands show while it is also the active
  // row. Arrows, the wheel and leaving the list let go of it.
  const [pointerSlug, setPointerSlug] = useState<string | null>(null);
  // The row whose menu is open holds the active row and its commands.
  const [menuSlug, setMenuSlug] = useState<string | null>(null);
  // ⌘K presses, answered by the active row's More menu.
  const [moreMenuRequestSequence, setMoreMenuRequestSequence] = useState(0);

  const normalizedQuery = normalizeSurfaceSearchQuery(query);
  const normalizedQueryLength = Array.from(normalizedQuery).length;
  const isRecentMode = normalizedQuery.length === 0;
  const queryReadyForSearch =
    isRecentMode || normalizedQueryLength >= SEARCH_OVERLAY_MIN_QUERY_CHARS;
  const currentQuerySettled = settledQueryKey === normalizedQuery;

  // searchQuery === null → recent mode: the same grid contract without a
  // query returns the canonical saved_at-DESC order (the feed's first page).
  const runSearch = useCallback(
    (searchQuery: string | null, options: { preserveActive: boolean }) => {
      const sequence = ++requestSequenceRef.current;
      const queryKey = searchQuery ?? "";
      const request = searchQuery === null
        ? listGridBlocks(undefined, 0, SEARCH_OVERLAY_RECENT_LIMIT)
        : searchGridBlocks(undefined, searchQuery, SEARCH_OVERLAY_RESULT_LIMIT);
      void request
        .then((snapshot) => {
          if (requestSequenceRef.current !== sequence) return;
          setResults((previous) => {
            if (options.preserveActive) {
              // Silent refresh (vault mutated): keep the user's place — follow
              // the active slug into the new result set, or clamp the index
              // when that card is gone (e.g. it was just deleted).
              setActiveIndex((index) => {
                const activeSlugBefore = previous?.[index]?.slug ?? null;
                const followed = activeSlugBefore
                  ? snapshot.blocks.findIndex((candidate) => candidate.slug === activeSlugBefore)
                  : -1;
                if (followed >= 0) return followed;
                return Math.min(index, Math.max(0, snapshot.blocks.length - 1));
              });
            } else {
              setActiveIndex(0);
            }
            return snapshot.blocks;
          });
          setResultHasMore(snapshot.has_more);
          setSettledQueryKey(queryKey);
          setFailedQuery(null);
          // New rows under a resting pointer wait for it to move (С7.5).
          if (!options.preserveActive) setPointerSlug(null);
        })
        .catch((error: unknown) => {
          if (requestSequenceRef.current !== sequence) return;
          console.error("Search overlay query failed:", error);
          // The rows on screen answer an older text or an older vault: none
          // of them is this text's answer, so none stays to be clicked or
          // opened with Enter. An Enter waiting for this answer is dropped
          // with it rather than firing on a later silent refresh (Г4.3).
          pendingOpenRef.current = null;
          setResults(null);
          setResultHasMore(false);
          setSettledQueryKey(null);
          setActiveIndex(0);
          setFailedQuery({
            key: queryKey,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [],
  );

  useEffect(() => {
    // New text: a response still in flight answers the old text and must not
    // land while this one waits out the debounce (А6.11). An Enter pressed for
    // the old text is dropped with it. Closing drops both the same way: the
    // overlay stays mounted, and a late answer must not open a card after
    // Escape (Б5.2).
    requestSequenceRef.current += 1;
    pendingOpenRef.current = null;
    if (!open) return;
    if (isRecentMode) {
      // Recent mode loads immediately: the debounce exists for the typing
      // race, a static list has nothing to wait for (Р-16).
      setActiveIndex(0);
      runSearch(null, { preserveActive: false });
      return;
    }
    if (!queryReadyForSearch) {
      setResults(null);
      setResultHasMore(false);
      setSettledQueryKey(null);
      setFailedQuery(null);
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => {
      runSearch(normalizedQuery, { preserveActive: false });
    }, SEARCH_OVERLAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [isRecentMode, normalizedQuery, open, queryReadyForSearch, runSearch]);

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
      if (!queryReadyForSearch) return;
      runSearch(normalizedQuery || null, { preserveActive: true });
    };
    window.addEventListener("vault-refreshed", handler);
    return () => window.removeEventListener("vault-refreshed", handler);
  }, [normalizedQuery, open, queryReadyForSearch, runSearch]);

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
        return next;
      });
    };
    window.addEventListener("block-deleted", handler);
    return () => window.removeEventListener("block-deleted", handler);
  }, [open]);

  const resolvedThumbsRoot = useMemo(
    () => thumbsRootPath ?? fallbackThumbsRoot(vaultPath),
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
      // The arrows take the active row from the pointer: its commands hide
      // until the pointer moves again.
      setPointerSlug(null);
      setActiveIndex((current) =>
        Math.min(results.length - 1, Math.max(0, current + delta)),
      );
    },
    [results],
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // ⌘K opens the active row's More menu, as on a card in the feed. The
      // menu takes the keyboard while open; ⌘K or Escape there closes it.
      if (commandById("element-menu").matches?.(event.nativeEvent)) {
        if (!activeBlock) return;
        event.preventDefault();
        setMoreMenuRequestSequence((current) => current + 1);
        return;
      }
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
      if (event.key !== "Enter") return;
      if (currentQuerySettled) {
        if (!activeBlock) return;
        event.preventDefault();
        onOpenBlock(activeBlock);
        return;
      }
      // The rows on screen answer an older text: ask for this one now,
      // without the debounce, and open its first result when it lands.
      if (!queryReadyForSearch) return;
      event.preventDefault();
      pendingOpenRef.current = normalizedQuery;
      runSearch(isRecentMode ? null : normalizedQuery, { preserveActive: false });
    },
    [
      activeBlock,
      currentQuerySettled,
      isRecentMode,
      moveActiveIndex,
      normalizedQuery,
      onOpenBlock,
      queryReadyForSearch,
      runSearch,
    ],
  );

  useEffect(() => {
    if (!open || pendingOpenRef.current === null || !currentQuerySettled) return;
    if (pendingOpenRef.current !== normalizedQuery) return;
    pendingOpenRef.current = null;
    if (activeBlock) onOpenBlock(activeBlock);
  }, [activeBlock, currentQuerySettled, normalizedQuery, onOpenBlock, open]);

  const menuRowPresent = menuSlug !== null && rows.some((entry) => entry.block.slug === menuSlug);

  const handleRowPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, index: number, slug: string) => {
      const last = lastPointerRef.current;
      if (last && last.x === event.clientX && last.y === event.clientY) return;
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      // An open row menu holds its row: the pointer on its way across other
      // rows moves nothing (SPEC_CARD_STATES.md, С7.8).
      if (menuRowPresent) return;
      setActiveIndex(index);
      setPointerSlug(slug);
    },
    [menuRowPresent],
  );

  const releasePointerRow = useCallback(() => setPointerSlug(null), []);

  // A reopened overlay starts with the pointer elsewhere.
  useEffect(() => {
    if (!open) setPointerSlug(null);
  }, [open]);

  const handleRowMenuOpenChange = useCallback((slug: string, menuOpen: boolean) => {
    setMenuSlug((current) => (menuOpen ? slug : current === slug ? null : current));
  }, []);

  // A closed row menu hands the keyboard back to the search field, where the
  // arrows, Enter, ⌘K and Escape keep working.
  const handleRowMenuCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    inputRef.current?.focus();
  }, []);

  const handleRequestRename = useCallback(
    (block: LightBlock) => onRequestRename?.(block),
    [onRequestRename],
  );
  const handleRequestDelete = useCallback(
    (slug: string) => onRequestDelete?.(slug),
    [onRequestDelete],
  );

  const handleClear = useCallback(() => {
    onQueryChange("");
    inputRef.current?.focus();
  }, [onQueryChange]);

  const showCount =
    !isRecentMode && queryReadyForSearch && currentQuerySettled && results !== null;
  const resultCountLabel =
    results && resultHasMore ? `${results.length}+` : `${results?.length ?? 0}`;
  const showNoResults =
    !isRecentMode
    && queryReadyForSearch
    && currentQuerySettled
    && results !== null
    && results.length === 0;
  // Recent mode fails the same way: an error is not an empty answer.
  const queryError =
    queryReadyForSearch && failedQuery?.key === normalizedQuery ? failedQuery.message : null;

  // One row template for both modes; `index` is always the flat results
  // index, so the active row and arrow keys ignore section grouping.
  // The row is two layers: the option (the result itself, what a click opens)
  // and, over its right end, the card's commands. They are siblings, so a
  // press on a command never reaches the option and the option's accessible
  // name stays the result's own. The common parent carries the active layer,
  // so both stand on the same surface.
  const renderResultRow = (
    { block, row, preview }: (typeof rows)[number],
    index: number,
  ) => {
    const isActive = index === activeIndex;
    const holdsMenu = menuRowPresent && block.slug === menuSlug;
    const actionsShown = holdsMenu || (isActive && block.slug === pointerSlug);
    // The commands overlay the row's end; the text stops short of them, and
    // the name, which keeps its place, only when it stands alone.
    const reservePx = actionsShown ? searchRowActionsReservePx(block) : 0;
    return (
      <div
        key={block.id}
        role="none"
        className={cn("relative rounded-1", isActive && "state-active")}
        onPointerMove={(event) => handleRowPointerMove(event, index, block.slug)}
        data-search-result-row=""
      >
        <div
          id={searchOverlayOptionDomId(block.id)}
          role="option"
          aria-selected={isActive}
          className="flex cursor-default items-center gap-2 px-2 py-1.5"
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
          <p className={RESULT_LINE_CLASSES} data-search-result-line="">
            <SearchResultName
              name={row.title}
              match={row.nameMatch}
              withText={row.text !== null}
              endReservePx={reservePx}
            />
            {row.text !== null && (
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                style={reservePx > 0 ? { paddingRight: reservePx } : undefined}
                data-search-result-text=""
              >
                {renderSearchHighlightedText(row.text, row.textMatch)}
              </span>
            )}
          </p>
        </div>
        {(isActive || holdsMenu) && (
          <SearchResultRowActions
            block={block}
            vaultPath={vaultPath}
            tags={tags}
            currentTag={currentTag}
            visible={actionsShown}
            moreMenuRequestSequence={isActive ? moreMenuRequestSequence : 0}
            onToggleTag={handleToggleTag}
            onCreateAndAssign={handleCreateAndAssign}
            onRequestRename={handleRequestRename}
            onRequestDelete={handleRequestDelete}
            onMenuOpenChange={handleRowMenuOpenChange}
            onMenuCloseAutoFocus={handleRowMenuCloseAutoFocus}
          />
        )}
      </div>
    );
  };

  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        ref={setMenuContainer}
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
          "gap-0 overflow-hidden bg-card p-0 text-card-foreground",
          "shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]",
        )}
        data-search-overlay
      >
        <DropdownMenuPortalContainerProvider container={menuContainer}>
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
            <span
              className="shrink-0 px-1 text-sm text-tertiary-foreground"
              data-search-overlay-result-count=""
            >
              {resultCountLabel}
            </span>
          )}
          {query.length > 0 && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={handleClear}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-1 text-muted-foreground hover:bg-component-fill-hover hover:text-foreground focus-visible:bg-component-fill-hover focus-visible:text-foreground focus-visible:outline-none"
            >
              <X className="size-[13px]" />
            </button>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            ref={resultsTopFade.ref}
            id="search-overlay-listbox"
            role="listbox"
            aria-label="Search results"
            className="min-w-0 flex-1 overflow-y-auto p-1"
            data-search-results-top-fade={resultsTopFade.scrolled ? "true" : undefined}
            // Rows that slide under a resting pointer, and a pointer gone
            // from the list, show no commands (SPEC_CARD_STATES.md, С7.5).
            onPointerLeave={releasePointerRow}
            onWheel={releasePointerRow}
          >
            {showNoResults && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No results
              </div>
            )}
            {queryError !== null && (
              <div
                role="alert"
                className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-sm"
                data-search-overlay-error=""
              >
                <p className="text-destructive">Search failed. Press Enter to try again.</p>
                <p className="text-muted-foreground">{queryError}</p>
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
          <TopFadeScrim
            scrolled={resultsTopFade.scrolled}
            surface="search"
            color="var(--card)"
          />
          </div>

          {/* Two zones: the card, the feed's own card in its final hover
              state with nothing to press (SPEC_CARD_STATES.md, С10), and the
              metadata block, a bare MetadataRow list with no card chrome of
              its own. */}
          <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
            {activeBlock && (
              <>
                <div
                  role="button"
                  tabIndex={-1}
                  aria-label="Open element"
                  onClick={() => onOpenBlock(activeBlock)}
                  data-search-overlay-preview
                >
                  <ReadOnlyCardPreview
                    block={activeBlock}
                    vaultPath={vaultPath}
                    thumbsRootPath={thumbsRootPath}
                    width={288}
                    shadow="none"
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
        </DropdownMenuPortalContainerProvider>
      </DialogContent>
    </Dialog>
  );
}
