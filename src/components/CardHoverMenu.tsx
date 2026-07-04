import {
  memo,
  useCallback,
  useEffect,
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
  onKeyboardMoreMenuOpenChange?: (open: boolean) => void;
  onInteractiveOpenChange?: (open: boolean) => void;
  onInteractionStart?: () => void;
};

function stopProp(e: React.MouseEvent | React.PointerEvent) {
  e.stopPropagation();
}

function isCommandK(event: ReactKeyboardEvent): boolean {
  return (
    event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    event.key.toLowerCase() === "k"
  );
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
          size="icon"
          className={className}
          {...(topChromeInteraction ? topChromeTrigger.triggerProps : {})}
        >
          <MoreHorizontal className="size-4" />
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

      <DropdownMenuItem onSelect={() => navigator.clipboard.writeText(filePath)}>
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
  onKeyboardMoreMenuOpenChange,
  onInteractiveOpenChange,
  onInteractionStart,
}: CardHoverMenuPropsWithState) {
  const hasUrl = block.url != null && isSafeUrl(block.url);
  const [menuOpen, setMenuOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [keyboardMenuOpen, setKeyboardMenuOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const lastOpenMoreMenuRequestSequenceRef = useRef(0);
  const keyboardMenuRequestPending =
    openMoreMenuRequestSequence > lastOpenMoreMenuRequestSequenceRef.current;
  const effectiveKeyboardMenuOpen = keyboardMenuOpen || keyboardMenuRequestPending;
  const anyMenuOpen = menuOpen || channelOpen;
  const hoverActionsPinned = channelOpen || (menuOpen && !effectiveKeyboardMenuOpen);

  useEffect(() => {
    if (openMoreMenuRequestSequence <= lastOpenMoreMenuRequestSequenceRef.current) return;
    lastOpenMoreMenuRequestSequenceRef.current = openMoreMenuRequestSequence;
  }, [openMoreMenuRequestSequence]);

  useEffect(() => {
    onInteractiveOpenChange?.(anyMenuOpen);
  }, [anyMenuOpen, onInteractiveOpenChange]);

  const shouldLoadTags = menuOpen || channelOpen;

  useEffect(() => {
    if (!shouldLoadTags) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) {
        setSelectedTags(full?.tags ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block.slug, shouldLoadTags]);

  return (
    <>
      {/* Overlay — затенение при hover */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-[4] bg-[var(--card-hover-overlay)] transition-opacity",
          hoverEnabled && "group-hover:opacity-100",
          hoverActionsPinned ? "opacity-100" : "opacity-0",
        )}
        data-card-hover-overlay=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
      />

      {/* More (···) — верхний правый */}
      <div
        className={cn(
          "pointer-events-none absolute right-2 top-2 z-[5] transition-opacity",
          hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
          anyMenuOpen ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        data-card-hover-more-action=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
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

      {/* Нижний ряд: Source (лево) + Connect (право) */}
      <div
        className={cn(
          "pointer-events-none absolute bottom-2 left-2 right-2 z-[5] flex gap-2 transition-opacity",
          hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
          hoverActionsPinned ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        data-card-hover-bottom-actions=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        {/* Source — низ лево */}
        {hasUrl && (
          <Button
            variant="default"
            size="default"
            className="flex-1"
            onClick={() => {
              onInteractionStart?.();
              if (block.url) openUrl(block.url);
            }}
          >
            Source
            <ExternalLink className="size-3" />
          </Button>
        )}

        {/* Connect — низ право */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              onInteractionStart?.();
            }
            setChannelOpen(open);
          }}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="default" size="default" className="flex-1">
              Connect
              <Plus className="size-3" />
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
