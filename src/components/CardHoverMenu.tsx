import { commandById } from "@/lib/commandRegistry";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ComponentProps } from "react";
import { MoreHorizontal, Plus, ExternalLink, Trash2, Unlink } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { IndexedBlock, LightBlock, TagCount } from "@/types";
import { getBlock } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { isSafeUrl } from "@/lib/assets";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import {
  COLLECTION_PICKER_CONTENT_CLASS,
  CollectionPicker,
} from "./CollectionPicker";
import { copyTextToClipboard } from "@/lib/clipboard";
import { CardCollectionsContext } from "@/lib/cardCollections";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";

interface CardMenuActionsProps<TBlock extends LightBlock | IndexedBlock> {
  block: TBlock;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: TBlock) => void;
  onRequestDelete: (slug: string) => void;
}

interface CardMoreMenuProps<TBlock extends LightBlock | IndexedBlock> extends CardMenuActionsProps<TBlock> {
  className?: string;
  onOpenChange?: (open: boolean) => void;
  openRequestSequence?: number;
  topChromeInteraction?: boolean;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  triggerSize?: ComponentProps<typeof Button>["size"];
}

interface CardPointMenuProps<TBlock extends LightBlock | IndexedBlock> extends CardMenuActionsProps<TBlock> {
  x: number;
  y: number;
  openRequestSequence: number;
  onOpenChange?: (open: boolean) => void;
}

interface CardMenuDropdownContentProps<TBlock extends LightBlock | IndexedBlock>
  extends CardMenuActionsProps<TBlock> {
  menuOpen: boolean;
  onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"];
  onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
  onPointerDownOutside?: ComponentProps<typeof DropdownMenuContent>["onPointerDownOutside"];
}

type CardHoverMenuProps = CardMenuActionsProps<LightBlock>;
type CardHoverMenuPropsWithState = CardHoverMenuProps & {
  openMoreMenuRequestSequence?: number;
  hoverEnabled?: boolean;
  /// Whether a <video> sits under these controls. Only then do they need a
  /// compositing layer of their own — see the comment at the More button.
  videoUnderneath?: boolean;
  onKeyboardMoreMenuOpenChange?: (open: boolean) => void;
  onInteractiveOpenChange?: (open: boolean) => void;
  onInteractionStart?: () => void;
  /// A pointer-opened menu holds the bottom row shown, and the card's lift
  /// with it (SPEC_CARD_STATES.md, С8).
  onActionsPinnedChange?: (pinned: boolean) => void;
};

/// The card's collections in its bottom row, left-aligned, as
/// plain clickable text: no plate, no outline. A name opens its collection.
/// The order is always the sidebar's manual one, read from the live list the
/// sidebar draws, so a reorder there shows here at once; a collection the
/// list does not hold goes last. Names past the row's end dissolve into the
/// edge before the plus, the sidebar strip's fade.
function CardCollectionsRow({
  collections,
  order,
}: {
  collections: readonly string[];
  /** The sidebar's collections in their manual order. */
  order: readonly TagCount[];
}) {
  const navigation = useContext(CardCollectionsContext);
  const ordered = useMemo(() => {
    const rank = new Map(order.map((entry, index) => [entry.tag, index]));
    return [...collections].sort(
      (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [collections, order]);
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden"
      style={COLLECTIONS_ROW_FADE_STYLE}
      data-card-collections-row=""
    >
      {ordered.length === 0 && (
        // A card in no collection says so, in the quietest interface tone.
        <span className="whitespace-nowrap font-mono text-sm text-tertiary-foreground" data-card-no-collections="">
          No collections
        </span>
      )}
      {ordered.map((tag) => (
        <button
          key={tag}
          type="button"
          className="shrink-0 whitespace-nowrap bg-transparent p-0 font-mono text-sm font-normal text-muted-foreground outline-0 hover:text-foreground focus-visible:text-foreground"
          data-card-collection-pill={tag}
          onClick={() => navigation?.open(tag)}
        >
          {collectionRefLabel(tag)}
        </button>
      ))}
    </div>
  );
}

/// The row's right edge fades over the shared edge width (lib/edgeFade.ts).
const COLLECTIONS_ROW_FADE_STYLE = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0);

function stopProp(e: React.MouseEvent | React.PointerEvent) {
  e.stopPropagation();
}

/** The element menu's chord from the command registry, rebinding included. */
function isCommandK(event: ReactKeyboardEvent): boolean {
  return commandById("element-menu").matches?.(event.nativeEvent) ?? false;
}

export function CardMoreMenu<TBlock extends LightBlock | IndexedBlock>({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  className,
  onOpenChange,
  openRequestSequence = 0,
  topChromeInteraction = false,
  triggerVariant = "default",
  triggerSize,
}: CardMoreMenuProps<TBlock>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const lastOpenRequestSequenceRef = useRef(0);

  const updateMenuOpen = useCallback((open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
    onOpenChange?.(open);
  }, [onOpenChange]);

  const topChromeTrigger = useTopChromeTriggerInteraction({
    dragDisabled: !topChromeInteraction,
    deferPointerOpen: topChromeInteraction,
    onPointerOpen: () => updateMenuOpen(!menuOpenRef.current),
  });

  const handleMenuKeyDownCapture = useCallback((event: ReactKeyboardEvent) => {
    if (!isCommandK(event)) return;
    event.preventDefault();
    event.stopPropagation();
    updateMenuOpen(false);
  }, [updateMenuOpen]);

  useEffect(() => {
    if (openRequestSequence <= lastOpenRequestSequenceRef.current) return;
    lastOpenRequestSequenceRef.current = openRequestSequence;
    updateMenuOpen(!menuOpenRef.current);
  }, [openRequestSequence, updateMenuOpen]);

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={updateMenuOpen}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize ?? (triggerVariant === "chrome" ? "chrome-icon" : "icon")}
          aria-label="Card actions"
          className={className}
          {...(topChromeInteraction ? topChromeTrigger.triggerProps : {})}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <CardMenuDropdownContent
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        menuOpen={menuOpen}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        onCloseAutoFocus={topChromeInteraction ? topChromeTrigger.handleCloseAutoFocus : undefined}
        onKeyDownCapture={handleMenuKeyDownCapture}
      />
    </DropdownMenu>
  );
}

function CardMenuDropdownContent<TBlock extends LightBlock | IndexedBlock>({
  block,
  vaultPath,
  tags,
  currentTag,
  menuOpen,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onCloseAutoFocus,
  onKeyDownCapture,
  onPointerDownOutside,
}: CardMenuDropdownContentProps<TBlock>) {
  const hasUrl = block.url != null && isSafeUrl(block.url);
  const filePath = `${vaultPath}/${block.slug}.md`;
  const [connectSubmenuOpen, setConnectSubmenuOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const connectTriggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      setConnectSubmenuOpen(false);
      return;
    }
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) {
        setSelectedTags(full?.tags ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block.slug, menuOpen]);

  return (
    <DropdownMenuContent
      align="end"
      onCloseAutoFocus={onCloseAutoFocus}
      onKeyDownCapture={onKeyDownCapture}
      onPointerDownOutside={onPointerDownOutside}
    >
      <DropdownMenuSub open={connectSubmenuOpen} onOpenChange={setConnectSubmenuOpen}>
        <DropdownMenuSubTrigger ref={connectTriggerRef}>
          <MenuIconSlot>
            <Plus className="size-3" />
          </MenuIconSlot>
          Connect
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          widthRole="picker"
          className={COLLECTION_PICKER_CONTENT_CLASS}
          onKeyDownCapture={onKeyDownCapture}
        >
          <CollectionPicker
            blockSlug={block.slug}
            selectedTags={selectedTags}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            stopKeyPropagation
            onRequestClose={() => {
              setConnectSubmenuOpen(false);
              requestAnimationFrame(() => connectTriggerRef.current?.focus());
            }}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      {hasUrl && (
        <DropdownMenuItem onSelect={() => openUrl(block.url!)}>
          <MenuIconSlot>
            <ExternalLink className="size-3" />
          </MenuIconSlot>
          Source
        </DropdownMenuItem>
      )}

      <DropdownMenuSeparator />

      <DropdownMenuItem onSelect={() => revealItemInDir(filePath)}>
        <MenuIconSlot />
        Reveal in Finder
      </DropdownMenuItem>

      <DropdownMenuItem onSelect={() => copyTextToClipboard(filePath)}>
        <MenuIconSlot />
        Copy Path
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem onSelect={() => onRequestRename(block)}>
        <MenuIconSlot />
        Rename…
      </DropdownMenuItem>

      {currentTag && selectedTags.includes(currentTag) && (
        <DropdownMenuItem
          variant="detach"
          onSelect={() => onToggleTag(block.slug, currentTag, true)}
        >
          <MenuIconSlot>
            <Unlink className="size-3" />
          </MenuIconSlot>
          Disconnect from &ldquo;{collectionRefLabel(currentTag)}&rdquo;
        </DropdownMenuItem>
      )}

      <DropdownMenuItem
        variant="destructive"
        onSelect={() => onRequestDelete(block.slug)}
      >
        <MenuIconSlot>
          <Trash2 className="size-3" />
        </MenuIconSlot>
        Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function CardPointMenu<TBlock extends LightBlock | IndexedBlock>({
  x,
  y,
  openRequestSequence,
  onOpenChange,
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
}: CardPointMenuProps<TBlock>) {
  const [menuOpen, setMenuOpen] = useState(true);

  const updateMenuOpen = useCallback((open: boolean) => {
    setMenuOpen(open);
    onOpenChange?.(open);
  }, [onOpenChange]);

  useEffect(() => {
    setMenuOpen(true);
  }, [openRequestSequence]);

  const handleDismissLayerClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    updateMenuOpen(false);
  }, [updateMenuOpen]);

  const handleDismissLayerContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    updateMenuOpen(false);
  }, [updateMenuOpen]);

  const stopDismissLayerPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <>
      {menuOpen ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-transparent"
          data-card-point-menu-dismiss-layer=""
          onPointerDown={stopDismissLayerPointer}
          onPointerUp={stopDismissLayerPointer}
          onClick={handleDismissLayerClick}
          onContextMenu={handleDismissLayerContextMenu}
        />
      ) : null}
      <div
        className="fixed z-50 size-px"
        style={{ left: x, top: y }}
        data-card-point-menu-anchor=""
      >
        <DropdownMenu open={menuOpen} onOpenChange={updateMenuOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-hidden="true"
              tabIndex={-1}
              className="size-px min-h-0 min-w-0 border-0 bg-transparent p-0 opacity-0"
              data-card-point-menu-trigger=""
            />
          </DropdownMenuTrigger>
          <CardMenuDropdownContent
            block={block}
            vaultPath={vaultPath}
            tags={tags}
            currentTag={currentTag}
            menuOpen={menuOpen}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            onRequestRename={onRequestRename}
            onRequestDelete={onRequestDelete}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              const target = event.target;
              if (target instanceof Element && target.closest("[data-card-point-menu-dismiss-layer]")) {
                event.preventDefault();
              }
            }}
          />
        </DropdownMenu>
      </div>
    </>
  );
}

export const CardHoverMenu = memo(function CardHoverMenu({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  openMoreMenuRequestSequence = 0,
  hoverEnabled = true,
  videoUnderneath = false,
  onKeyboardMoreMenuOpenChange,
  onInteractiveOpenChange,
  onInteractionStart,
  onActionsPinnedChange,
}: CardHoverMenuPropsWithState) {
  // The card's hover controls (chosen 02.10.2026 from four versions tried
  // side by side): Source and More at the top right; the card's collections
  // and Connect as a plus in a row at the bottom, sliding out with the card's
  // lift (SPEC_CARD_STATES.md, С8).
  const hasUrl = block.url != null && isSafeUrl(block.url);
  const [menuOpen, setMenuOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [keyboardMenuOpen, setKeyboardMenuOpen] = useState(false);
  const lastOpenMoreMenuRequestSequenceRef = useRef(0);
  const keyboardMenuRequestPending =
    openMoreMenuRequestSequence > lastOpenMoreMenuRequestSequenceRef.current;
  const effectiveKeyboardMenuOpen = keyboardMenuOpen || keyboardMenuRequestPending;
  const anyMenuOpen = menuOpen || channelOpen;
  // A pointer-opened menu holds the card's hover state (С8); a keyboard one
  // does not.
  const hoverActionsPinned = channelOpen || (menuOpen && !effectiveKeyboardMenuOpen);

  useEffect(() => {
    if (openMoreMenuRequestSequence <= lastOpenMoreMenuRequestSequenceRef.current) return;
    lastOpenMoreMenuRequestSequenceRef.current = openMoreMenuRequestSequence;
  }, [openMoreMenuRequestSequence]);

  useEffect(() => {
    onInteractiveOpenChange?.(anyMenuOpen);
  }, [anyMenuOpen, onInteractiveOpenChange]);

  useEffect(() => {
    onActionsPinnedChange?.(hoverActionsPinned);
  }, [hoverActionsPinned, onActionsPinnedChange]);

  // Connect shows the card's collections ticked: read them when it opens.
  useEffect(() => {
    if (!channelOpen) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) setSelectedTags(full?.tags ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [block.slug, channelOpen]);

  return (
    <>
      {/* Overlay — затенение при hover */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-[4] bg-[var(--card-hover-overlay)] transition-opacity",
          videoUnderneath && "transform-gpu",
          hoverEnabled && "group-hover:opacity-100",
          hoverActionsPinned ? "opacity-100" : "opacity-0",
        )}
        data-card-hover-overlay=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
      />

      {/* Source and More (···) at the top right. A layer of its own is load-bearing over
          video: WKWebView promotes <video> to its own compositing layer, and a
          plain positioned sibling loses to it in paint order despite the higher
          z-index — the button drew underneath feed videos.
          It is asked for only where that fight exists. Promoting these three
          layers on every card cost four times the memory and five times the
          rendering load, measured 20.08.2026: 1.3 GB and a third of a core at
          rest, against 320 MB and five per cent with them off. A card without
          video has nothing to lose the fight to. */}
      <div
        className={cn(
          // The card menu at the top right, the link's button to its left.
          "pointer-events-none absolute right-2 top-2 z-[5] flex items-center gap-1 transition-opacity",
          videoUnderneath && "transform-gpu",
          hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
          anyMenuOpen ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        data-card-hover-more-action=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        {hasUrl && (
          <Button
            variant="default"
            size="icon-xs"
            aria-label="Source"
            // Leaves the app for the browser: the one case that keeps the
            // pointing hand under the native cursor contract.
            className="cursor-pointer"
            onClick={() => {
              onInteractionStart?.();
              if (block.url) openUrl(block.url);
            }}
          >
            <ExternalLink aria-hidden="true" />
          </Button>
        )}
        <CardMoreMenu
          block={block}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
          openRequestSequence={openMoreMenuRequestSequence}
          triggerSize="icon-xs"
          onOpenChange={(open) => {
            if (open) {
              if (keyboardMenuRequestPending) {
                setKeyboardMenuOpen(true);
                onKeyboardMoreMenuOpenChange?.(true);
              }
              onInteractionStart?.();
            } else {
              if (keyboardMenuOpen || keyboardMenuRequestPending) {
                onKeyboardMoreMenuOpenChange?.(false);
              }
              setKeyboardMenuOpen(false);
            }
            setMenuOpen(open);
          }}
        />
      </div>

      {/* The card's collections, left-aligned, and Connect as a plus at the
          right; the row rises with the card's lift (SPEC_CARD_STATES.md, С8).
          It shows only where the card lifts: under the pointer, or held by a
          menu the pointer opened. A menu the keyboard opens lifts nothing,
          so the row stays hidden rather than cover the card's text. */}
      <div
        className={cn(
          "pointer-events-none absolute bottom-2 left-2 right-2 z-[5] flex items-center gap-1",
          hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
          hoverActionsPinned ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        data-card-lift="tray"
        data-card-lift-gpu={videoUnderneath ? "" : undefined}
        data-card-hover-bottom-actions=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        <CardCollectionsRow collections={block.collections} order={tags} />
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) onInteractionStart?.();
            setChannelOpen(open);
          }}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="default"
              size="icon-xs"
              aria-label="Connect"
              className="ml-auto"
              data-card-hover-connect=""
            >
              <Plus aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS} align="end">
            <CollectionPicker
              blockSlug={block.slug}
              selectedTags={selectedTags}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              stopKeyPropagation
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
});
