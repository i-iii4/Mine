import { commandById } from "@/lib/commandRegistry";
import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { ComponentProps } from "react";
import { MoreHorizontal, Plus, ExternalLink, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { useCommandOverrides } from "@/hooks/useCommandOverrides";
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
import { collectionRefLabel } from "@/lib/collections";
import { isSafeUrl } from "@/lib/assets";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import {
  COLLECTION_PICKER_CONTENT_CLASS,
  CollectionPicker,
} from "./CollectionPicker";
import { openLinkInBrowser } from "@/lib/systemActions";
import { useCardMembership } from "@/hooks/useCardMembership";
import { useCollectionNameCheck } from "@/hooks/useCollectionNameRefusal";
import { CardCollectionsContext } from "@/lib/cardCollections";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";
import { noFocusBackAfterPress, onPointerOffMenus, pointerIsOnMenu, useContextMenuPresence } from "@/lib/openMenus";
import { editorTableMenu, subscribeEditorTableMenu } from "@/lib/editorTableMenu";
import {
  cardMenuEntries,
  runCardMenuItem,
  type CardMenuEntry,
  type CardMenuItemId,
  type CardMenuTableCommand,
} from "@/lib/cardMenuEntries";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import type { CardMenuOpenerKind, CardMenuPayload, MenuPanelAction, MenuPanelAnswer } from "@/lib/menuPanelProtocol";
import { menuPanelUsable, openMenuPanel, openingInputAt, type MenuPanelSession } from "@/lib/menuPanelSource";

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
  /** The keystroke that opens this menu, shown in the trigger's tooltip. */
  triggerShortcut?: string;
  /** Where focus goes when the menu closes; the trigger by default. A search
   *  result row sends it back to the search field. */
  onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"];
  /** The plate the menu comes out of, when it is not the trigger. */
  plateOf?: ComponentProps<typeof DropdownMenuContent>["plateOf"];
  /** TRIAL: the feed card's menu opens in the menu panel when the menu mode
   *  is `window` (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»). */
  panelMenu?: boolean;
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
  plateOf?: ComponentProps<typeof DropdownMenuContent>["plateOf"];
  onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
}

type CardHoverMenuProps = CardMenuActionsProps<LightBlock>;
type CardHoverMenuPropsWithState = CardHoverMenuProps & {
  openMoreMenuRequestSequence?: number;
  hoverEnabled?: boolean;
  /// Whether a <video> sits under these controls. Only then do they need a
  /// compositing layer of their own — see the comment at the More button.
  videoUnderneath?: boolean;
  /// The keyboard's card shows the chord of its menu at the end of the top row.
  menuBadge?: CardMenuBadgeCommand | null;
  /// The card lifts (SPEC_CARD_STATES.md, С8): only then does a row of its
  /// collections rise with it. In `media-only` no card lifts, and hover
  /// brings up the top buttons alone (SPEC_FEED_DISPLAY.md, Д31).
  lifts?: boolean;
  /// The keyboard's card lifts as on hover and shows its collections' names,
  /// with no buttons (SPEC_CARD_STATES.md, С8.5).
  keyboardLift?: boolean;
  /// The pointer has arrived on this card (С8.6).
  hoverArmed?: boolean;
  onKeyboardMoreMenuOpenChange?: (open: boolean) => void;
  onInteractiveOpenChange?: (open: boolean) => void;
  onInteractionStart?: () => void;
  /// A pointer-opened menu holds the bottom row shown, and the card's lift
  /// with it (SPEC_CARD_STATES.md, С8).
  onActionsPinnedChange?: (pinned: boolean) => void;
};

/// The menu ⌘K opens on the keyboard's card, one card's or the selection's.
export type CardMenuBadgeCommand = "element-menu" | "batch-menu";

/// The plate the keyboard's menu comes out of (SPEC_CARD_STATES.md, С8.8; user's
/// decision of 05.11.2026), found from the menu's trigger.
export function cardMenuBadgeOf(trigger: HTMLElement): HTMLElement | null {
  return trigger.closest("[data-feed-grid-item]")?.querySelector<HTMLElement>("[data-feed-grid-action-badge]") ?? null;
}

/// The chord that opens the focused card's menu, as the registry holds it now:
/// a rebind in Settings relabels the badge at once (SPEC_AUDIT_FIXES.md, Ф11).
function CardMenuBadge({ command, videoUnderneath }: { command: CardMenuBadgeCommand; videoUnderneath: boolean }) {
  useCommandOverrides();
  return (
    <div
      aria-hidden="true"
      className={cn("flex h-6 items-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground", videoUnderneath && "transform-gpu")}
      data-feed-grid-action-badge=""
    >
      {commandById(command).combo}
    </div>
  );
}

/// The card's collections in its bottom row, left-aligned, as
/// plain clickable text: no plate, no outline. A name opens its collection.
/// The order is always the sidebar's manual one, read from the live list the
/// sidebar draws, so a reorder there shows here at once; a collection the
/// list does not hold goes last. Names past the row's end dissolve into the
/// edge before the plus, the sidebar strip's fade. A card preview shows the
/// same row `readOnly`: the names as text, nothing to press
/// (SPEC_CARD_STATES.md, С10).
export function CardCollectionsRow({
  collections,
  order,
  readOnly = false,
}: {
  collections: readonly string[];
  /** The sidebar's collections in their manual order. */
  order: readonly TagCount[];
  readOnly?: boolean;
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
      {ordered.map((tag) => readOnly ? (
        <span key={tag} className={COLLECTION_NAME_CLASS} data-card-collection-name={tag}>
          {collectionRefLabel(tag)}
        </span>
      ) : (
        <button
          key={tag}
          type="button"
          className={cn(
            COLLECTION_NAME_CLASS,
            "bg-transparent p-0 outline-0 hover:text-foreground focus-visible:text-foreground",
          )}
          data-card-collection-pill={tag}
          onClick={() => navigation?.open(tag)}
        >
          {collectionRefLabel(tag)}
        </button>
      ))}
    </div>
  );
}

/// A collection's name in the row: interface text, quiet.
const COLLECTION_NAME_CLASS = "shrink-0 whitespace-nowrap font-mono text-sm font-normal text-muted-foreground";

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
  triggerShortcut,
  onCloseAutoFocus,
  plateOf,
  panelMenu = false,
}: CardMoreMenuProps<TBlock>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const lastOpenRequestSequenceRef = useRef(0);
  // The opening drawn in the menu panel, with the time of the input that
  // opened it; null while the menu is on the page or closed.
  const [inPanel, setInPanel] = useState<{ eventAt: number; byKey: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const updateMenuOpen = useCallback((open: boolean) => {
    if (open && !menuOpenRef.current && panelMenu && menuPanelUsable()) {
      setInPanel({ eventAt: openingInputAt(), byKey: lastInputIsKey() });
    } else if (!open) {
      setInPanel(null);
    }
    menuOpenRef.current = open;
    setMenuOpen(open);
    onOpenChange?.(open);
  }, [onOpenChange, panelMenu]);

  // The button's plate, or the plate the menu comes out of, on the page.
  const panelAnchor = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger === null) return null;
    return (plateOf?.(trigger) ?? menuPlateOf(trigger)).getBoundingClientRect();
  }, [plateOf]);

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
      open={menuOpen && inPanel === null}
      onOpenChange={updateMenuOpen}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize ?? (triggerVariant === "chrome" ? "chrome-icon" : "icon")}
          aria-label="Card actions"
          shortcut={triggerShortcut}
          className={className}
          {...(topChromeInteraction ? topChromeTrigger.triggerProps : { ref: triggerRef })}
          // The menu is open in the panel: the button looks as it does with
          // its menu open on the page.
          {...(menuOpen && inPanel !== null ? { "data-state": "open", "aria-expanded": true } : {})}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <CardMenuDropdownContent
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        menuOpen={menuOpen && inPanel === null}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        onCloseAutoFocus={topChromeInteraction ? topChromeTrigger.handleCloseAutoFocus : onCloseAutoFocus}
        onKeyDownCapture={handleMenuKeyDownCapture}
        plateOf={plateOf}
      />
      {menuOpen && inPanel !== null && (
        <CardMenuPanelBridge
          block={block}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
          opener={PLATE_END_OPENER}
          anchor={panelAnchor}
          eventAt={inPanel.eventAt}
          byKey={inPanel.byKey}
          contextMenu={false}
          onClosed={() => updateMenuOpen(false)}
          // The panel could not show it: the menu opens on the page, as
          // before the trial.
          onRefused={() => setInPanel(null)}
        />
      )}
    </DropdownMenu>
  );
}

/** The feed card's `···` and ⌘K menus stand flush with their plate's right
 *  edge (`align="end"`). */
const PLATE_END_OPENER: CardMenuOpenerKind = { kind: "plate", align: "end" };
const POINT_OPENER: CardMenuOpenerKind = { kind: "point" };

interface CardMenuPanelBridgeProps<TBlock extends LightBlock | IndexedBlock> extends CardMenuActionsProps<TBlock> {
  opener: CardMenuOpenerKind;
  /** The anchor on the page when the menu opens: the plate, or the point as
   *  a rectangle of no size. */
  anchor: () => { x: number; y: number; width: number; height: number } | null;
  eventAt: number;
  byKey: boolean;
  contextMenu: boolean;
  onClosed: () => void;
  onRefused: () => void;
}

/**
 * TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the
 * card menu drawn in the menu panel. It draws nothing on the page: it sends
 * the panel the same list the page's menu draws, sends it again whenever it
 * changes (the file's collections arrive, the editor's table goes), and runs
 * each choice made in the panel with the handlers the page's menu runs.
 */
function CardMenuPanelBridge<TBlock extends LightBlock | IndexedBlock>({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  opener,
  anchor,
  eventAt,
  byKey,
  contextMenu,
  onClosed,
  onRefused,
}: CardMenuPanelBridgeProps<TBlock>) {
  // The collections the feed knows, then what the file says (Е6.12).
  const selectedTags = useCardMembership(block, true);
  const { entries, run, tableMenu } = useCardMenuModel(
    { block, vaultPath, currentTag, onToggleTag, onRequestRename, onRequestDelete },
    selectedTags,
  );
  const checkName = useCollectionNameCheck(undefined);
  const payload = useMemo<CardMenuPayload>(() => ({
    opener,
    byKey,
    buttons: document.documentElement.getAttribute("data-buttons"),
    entries,
    picker: { blockSlug: block.slug, selectedTags, tags, currentTag: currentTag ?? null },
  }), [opener, byKey, entries, block.slug, selectedTags, tags, currentTag]);

  const latest = useRef({ payload, run, tableMenu, checkName, onToggleTag, onCreateAndAssign, onClosed, onRefused, slug: block.slug });
  latest.current = { payload, run, tableMenu, checkName, onToggleTag, onCreateAndAssign, onClosed, onRefused, slug: block.slug };
  const sessionRef = useRef<MenuPanelSession | null>(null);

  useEffect(() => {
    // The opening waits a microtask: React's development double run of the
    // effect cancels the first before anything reaches the backend.
    let cancelled = false;
    let session: MenuPanelSession | null = null;
    queueMicrotask(() => {
      if (cancelled) return;
      session = openNow();
      sessionRef.current = session;
    });
    return () => {
      cancelled = true;
      sessionRef.current = null;
      session?.close("source");
    };
    // One opening per mount: what changes later goes by `update`.
  }, []);

  function openNow(): MenuPanelSession | null {
    const rect = anchor();
    if (rect === null) {
      latest.current.onRefused();
      return null;
    }
    const act = async (action: MenuPanelAction): Promise<MenuPanelAnswer> => {
      const now = latest.current;
      switch (action.kind) {
        case "run":
          now.run(action.id);
          return { kind: "done" };
        case "table":
          now.tableMenu?.run(action.id);
          return { kind: "done" };
        case "toggle": {
          // The feed's handler answers whether the change was made, as the
          // picker on the page hears it.
          const made: unknown = await (now.onToggleTag(now.slug, action.tag, action.hasTag) as unknown);
          return { kind: "membership", made: typeof made === "boolean" ? made : null };
        }
        case "create":
          await now.onCreateAndAssign(action.tag, now.slug);
          return { kind: "done" };
        case "check":
          return { kind: "refusal", reason: now.checkName ? await now.checkName(action.name) : null };
      }
    };
    return openMenuPanel(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      latest.current.payload,
      {
        onAction: act,
        onClosed: () => latest.current.onClosed(),
        onRefused: () => latest.current.onRefused(),
      },
      { contextMenu, eventAt },
    );
  }

  useEffect(() => {
    sessionRef.current?.update(payload);
  }, [payload]);

  return null;
}

/**
 * TRIAL: the feed card's right click menu in the menu panel, at the point of
 * the click. When the panel cannot show it, the card's point menu opens on
 * the page at the same point.
 */
export function CardPanelPointMenu<TBlock extends LightBlock | IndexedBlock>({
  x,
  y,
  eventAt,
  onClose,
  ...actions
}: CardMenuActionsProps<TBlock> & { x: number; y: number; eventAt: number; onClose: () => void }) {
  const [onPage, setOnPage] = useState(false);
  const anchor = useCallback(() => ({ x, y, width: 0, height: 0 }), [x, y]);
  if (onPage) {
    return (
      <CardPointMenu
        {...actions}
        x={x}
        y={y}
        openRequestSequence={1}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      />
    );
  }
  return (
    <CardMenuPanelBridge
      {...actions}
      opener={POINT_OPENER}
      anchor={anchor}
      eventAt={eventAt}
      byKey={false}
      contextMenu
      onClosed={onClose}
      onRefused={() => setOnPage(true)}
    />
  );
}

/** The commands of no table: one empty list, so the entries keep their
 *  identity while no table is active. */
const NO_TABLE_COMMANDS: readonly CardMenuTableCommand[] = [];

/** The card menu's list (src/lib/cardMenuEntries.ts) and how its commands
 *  run, from the props every opening of the menu shares. */
function useCardMenuModel<TBlock extends LightBlock | IndexedBlock>(
  {
    block,
    vaultPath,
    currentTag,
    onToggleTag,
    onRequestRename,
    onRequestDelete,
  }: Pick<CardMenuActionsProps<TBlock>, "block" | "vaultPath" | "currentTag" | "onToggleTag" | "onRequestRename" | "onRequestDelete">,
  selectedTags: readonly string[],
) {
  const url = block.url != null && isSafeUrl(block.url) ? block.url : null;
  const filePath = `${vaultPath}/${block.slug}.md`;
  // The commands of the table active in the card's editor (SPEC_EDITING.md,
  // Л9.8, Л16); after one the editor keeps the focus it takes.
  const tableMenu = useSyncExternalStore(subscribeEditorTableMenu, editorTableMenu, () => null);
  const tableCommands = tableMenu?.slug === block.slug ? tableMenu.commands : NO_TABLE_COMMANDS;
  const disconnectFrom = currentTag && selectedTags.includes(currentTag) ? currentTag : null;
  const entries = useMemo(
    () => cardMenuEntries({ hasUrl: url !== null, disconnectFrom, tableCommands }),
    [url, disconnectFrom, tableCommands],
  );
  const run = useCallback(
    (id: CardMenuItemId) => runCardMenuItem(id, { block, url, filePath, currentTag, onToggleTag, onRequestRename, onRequestDelete }),
    [block, url, filePath, currentTag, onToggleTag, onRequestRename, onRequestDelete],
  );
  return { entries, run, tableMenu };
}

const CARD_MENU_ICONS = {
  external: ExternalLink,
  unlink: Unlink,
  trash: Trash2,
} as const;

/**
 * The card menu's rows inside a `DropdownMenuContent`: the menu on the page
 * and the menu in the panel draw the same rows with the same primitives
 * (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»). `connect`
 * holds the Connect submenu's state and its picker; `collisionPadding` is
 * the submenus' distance from the edges, the wrappers' own unless given.
 */
export function CardMenuEntriesView({
  entries,
  onRun,
  onTableCommand,
  connect,
  onKeyDownCapture,
  collisionPadding,
}: {
  entries: readonly CardMenuEntry[];
  onRun: (id: CardMenuItemId) => void;
  onTableCommand: (id: string) => void;
  connect: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    triggerRef?: Ref<HTMLDivElement>;
    picker: ReactNode;
  };
  onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
  collisionPadding?: number;
}) {
  return entries.map((entry) => {
    switch (entry.kind) {
      case "connect":
        return (
          <DropdownMenuSub key="connect" open={connect.open} onOpenChange={connect.onOpenChange}>
            <DropdownMenuSubTrigger ref={connect.triggerRef}>
              <MenuIconSlot>
                <Plus className="size-[13px]" />
              </MenuIconSlot>
              Connect
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              widthRole="search"
              className={COLLECTION_PICKER_CONTENT_CLASS}
              collisionPadding={collisionPadding}
              onKeyDownCapture={onKeyDownCapture}
            >
              {connect.picker}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      case "table":
        return (
          <DropdownMenuSub key="table">
            <DropdownMenuSubTrigger>
              <MenuIconSlot />
              Table
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent collisionPadding={collisionPadding} onKeyDownCapture={onKeyDownCapture}>
              {entry.commands.map((command) => (
                <Fragment key={command.id}>
                  {command.separatorBefore && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    variant={command.destructive ? "destructive" : "default"}
                    onSelect={() => onTableCommand(command.id)}
                  >
                    <MenuIconSlot />
                    {command.label}
                  </DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      case "separator":
        return <DropdownMenuSeparator key={`separator-${entry.key}`} />;
      case "item": {
        const Icon = entry.icon === null ? null : CARD_MENU_ICONS[entry.icon];
        return (
          <DropdownMenuItem key={entry.id} variant={entry.variant} onSelect={() => onRun(entry.id)}>
            {Icon === null ? (
              <MenuIconSlot />
            ) : (
              <MenuIconSlot>
                <Icon className="size-[13px]" />
              </MenuIconSlot>
            )}
            {entry.truncate ? <span className="min-w-0 truncate">{entry.label}</span> : entry.label}
          </DropdownMenuItem>
        );
      }
    }
  });
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
  plateOf,
}: CardMenuDropdownContentProps<TBlock>) {
  const [connectSubmenuOpen, setConnectSubmenuOpen] = useState(false);
  // The collections the feed knows, then what the file says (Е6.12).
  const selectedTags = useCardMembership(block, menuOpen);
  const connectTriggerRef = useRef<HTMLDivElement>(null);
  const { entries, run, tableMenu } = useCardMenuModel(
    { block, vaultPath, currentTag, onToggleTag, onRequestRename, onRequestDelete },
    selectedTags,
  );
  const tableCommandRan = useRef(false);

  useEffect(() => {
    if (!menuOpen) setConnectSubmenuOpen(false);
  }, [menuOpen]);

  return (
    <DropdownMenuContent
      align="end"
      plateOf={plateOf}
      onCloseAutoFocus={(event) => {
        if (tableCommandRan.current) {
          tableCommandRan.current = false;
          event.preventDefault();
          return;
        }
        onCloseAutoFocus?.(event);
      }}
      onKeyDownCapture={onKeyDownCapture}
    >
      <CardMenuEntriesView
        entries={entries}
        onRun={run}
        onTableCommand={(id) => {
          tableCommandRan.current = true;
          tableMenu?.run(id);
        }}
        onKeyDownCapture={onKeyDownCapture}
        connect={{
          open: connectSubmenuOpen,
          onOpenChange: setConnectSubmenuOpen,
          triggerRef: connectTriggerRef,
          picker: (
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
          ),
        }}
      />
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

  // A right click opened it: a context menu in all but its anchor. The first
  // press outside only closes it, as every menu's (src/lib/openMenus.ts).
  useContextMenuPresence(menuOpen);

  return (
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
        />
      </DropdownMenu>
    </div>
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
  menuBadge = null,
  lifts = true,
  keyboardLift = false,
  hoverArmed = false,
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
  const [keyboardMenuOpen, setKeyboardMenuOpen] = useState(false);
  const lastOpenMoreMenuRequestSequenceRef = useRef(0);
  const keyboardMenuRequestPending =
    openMoreMenuRequestSequence > lastOpenMoreMenuRequestSequenceRef.current;
  const effectiveKeyboardMenuOpen = keyboardMenuOpen || keyboardMenuRequestPending;
  const anyMenuOpen = menuOpen || channelOpen;
  // A pointer-opened menu holds the card's hover state (С8); a keyboard one
  // does not.
  // A menu closing under the pointer keeps the hold until WebKit gives `:hover`
  // to what lay under it, or the card would drop and rise again (С7.8).
  const [heldPastClose, setHeldPastClose] = useState(false);
  const hoverActionsPinned = channelOpen || (menuOpen && !effectiveKeyboardMenuOpen) || heldPastClose;
  // The row keeps the keyboard's form while it fades out behind the card going
  // down, or a plus would flash on it; the end of that fade gives it back.
  const [keyboardRow, setKeyboardRow] = useState(false);
  if (keyboardLift && !keyboardRow) setKeyboardRow(true);
  // The pointer arriving on this card takes the row at once: it never fades.
  else if (!keyboardLift && keyboardRow && hoverArmed) setKeyboardRow(false);

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

  useEffect(() => {
    if (!heldPastClose) return;
    return onPointerOffMenus(() => setHeldPastClose(false));
  }, [heldPastClose]);

  return (
    <>
      {/* Overlay — затенение при hover */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-[4] bg-[var(--card-hover-overlay)]",
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
      <div className="pointer-events-none absolute right-2 top-2 z-[5] flex items-center gap-1" data-card-top-row="">
      <div
        className={cn(
          // The card menu at the top right, the link's button to its left, and
          // the keyboard's chord after them.
          "pointer-events-none flex items-center gap-1",
          videoUnderneath && "transform-gpu",
          hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
          // A menu ⌘K opened comes out of the chord alone: the buttons stay
          // hidden in keyboard use (SPEC_CARD_STATES.md, С8.8).
          (anyMenuOpen && !effectiveKeyboardMenuOpen) || heldPastClose ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        data-card-hover-more-action=""
        data-card-hover-enabled={hoverEnabled ? "true" : undefined}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        {hasUrl && <CardSourceButton url={block.url!} onPress={onInteractionStart} />}
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
          triggerVariant="raised"
          // No keystroke in its tooltip: ⌘K opens the menu of the card the
          // keyboard is on, not of the one under the pointer.
          triggerSize="icon-xs"
          // A menu ⌘K opened comes out of the chord's plate, the pointer's out
          // of the button (SPEC_CARD_STATES.md, С8.8).
          plateOf={effectiveKeyboardMenuOpen ? cardMenuBadgeOf : undefined}
          onCloseAutoFocus={noFocusBackAfterPress}
          panelMenu
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
              } else if (pointerIsOnMenu()) {
                setHeldPastClose(true);
              }
              setKeyboardMenuOpen(false);
            }
            setMenuOpen(open);
          }}
        />
      </div>
      {menuBadge && <CardMenuBadge command={menuBadge} videoUnderneath={videoUnderneath} />}
      </div>

      {/* The card's collections, left-aligned, and Connect as a plus at the
          right; the row rises with the card's lift (SPEC_CARD_STATES.md, С8).
          It shows only where the card lifts: under the pointer, held by a menu
          the pointer opened, or on the keyboard's card, there as names alone,
          running to the card's right edge, where the row's own fade ends: there
          is no plus to stop at (С8.5, С8.9). A card that does not lift has no
          row: its plus stands alone below (SPEC_FEED_DISPLAY.md, Д31). */}
      {lifts && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-2 left-2 z-[5] flex items-center gap-1",
            // As tall as with the plus, so the letters stand where the pointer's do.
            keyboardRow ? "right-0 h-6" : "right-2",
            hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
            hoverActionsPinned ? "pointer-events-auto opacity-100" : keyboardLift ? "opacity-100" : "opacity-0",
          )}
          data-card-lift="tray"
          data-card-lift-gpu={videoUnderneath ? "" : undefined}
          data-card-hover-bottom-actions=""
          data-card-hover-enabled={hoverEnabled ? "true" : undefined}
          data-card-keyboard-row={keyboardRow ? "" : undefined}
          onClick={stopProp}
          onPointerDown={stopProp}
          onTransitionEnd={(event) => {
            if (keyboardRow && !keyboardLift && event.target === event.currentTarget && event.propertyName === "opacity") {
              setKeyboardRow(false);
            }
          }}
        >
          <CardCollectionsRow collections={block.collections} order={tags} readOnly={keyboardRow} />
          {!keyboardRow && (
            <CardConnectMenu
              block={block}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              className="ml-auto"
              onCloseAutoFocus={noFocusBackAfterPress}
              onOpenChange={(open) => {
                if (open) onInteractionStart?.();
                else if (pointerIsOnMenu()) setHeldPastClose(true);
                setChannelOpen(open);
              }}
            />
          )}
        </div>
      )}

      {/* A card that does not lift (`media-only`) shows Connect as a plus at
          its bottom right, with the top buttons and as they do: on hover and
          while a menu the pointer opened is up, never for the keyboard; no
          row, no names (SPEC_FEED_DISPLAY.md, Д31; user's decision of
          12.11.2026). */}
      {!lifts && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-2 right-2 z-[5] flex items-center",
            videoUnderneath && "transform-gpu",
            hoverEnabled && "group-hover:pointer-events-auto group-hover:opacity-100",
            (anyMenuOpen && !effectiveKeyboardMenuOpen) || heldPastClose ? "pointer-events-auto opacity-100" : "opacity-0",
          )}
          data-card-hover-connect-action=""
          data-card-hover-enabled={hoverEnabled ? "true" : undefined}
          onClick={stopProp}
          onPointerDown={stopProp}
        >
          <CardConnectMenu
            block={block}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            onCloseAutoFocus={noFocusBackAfterPress}
            onOpenChange={(open) => {
              if (open) onInteractionStart?.();
              else if (pointerIsOnMenu()) setHeldPastClose(true);
              setChannelOpen(open);
            }}
          />
        </div>
      )}
    </>
  );
});

/// The card's way out to its source: the link opens in the browser. The
/// card's top row and a search result row show the same button.
export function CardSourceButton({ url, onPress }: { url: string; onPress?: () => void }) {
  return (
    <Button
      variant="raised"
      size="icon-xs"
      aria-label="Source"
      // Leaves the app for the browser: the one case that keeps the
      // pointing hand under the native cursor contract.
      className="cursor-pointer"
      onClick={() => {
        onPress?.();
        openLinkInBrowser(url);
      }}
    >
      <ExternalLink aria-hidden="true" />
    </Button>
  );
}

/// Connect as a plus with the collection picker. The card's bottom row and a
/// card row of a list (search, Related notes) show the same menu.
export function CardConnectMenu({
  block,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  className,
  onOpenChange,
  onCloseAutoFocus,
}: Pick<CardMenuActionsProps<LightBlock | IndexedBlock>, "block" | "tags" | "currentTag" | "onToggleTag" | "onCreateAndAssign"> & {
  className?: string;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes when the picker closes; the plus by default. */
  onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"];
}) {
  const [open, setOpen] = useState(false);
  // The picker shows the card's collections ticked: the feed's, then what
  // the file says when it opens (Е6.12).
  const selectedTags = useCardMembership(block, open);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="raised"
          size="icon-xs"
          aria-label="Connect"
          className={className}
          data-card-hover-connect=""
        >
          <Plus aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        widthRole="search"
        className={COLLECTION_PICKER_CONTENT_CLASS}
        align="end"
        onCloseAutoFocus={onCloseAutoFocus}
      >
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
  );
}
