import { commandById } from "@/lib/commandRegistry";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ComponentProps } from "react";
import { MoreHorizontal, Plus, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { useCommandOverrides } from "@/hooks/useCommandOverrides";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { IndexedBlock, LightBlock, MenuAction, MenuAnswer, MenuOpener, MenuSpec, MenuWidgetAction, TagCount } from "@/types";
import { collectionRefLabel } from "@/lib/collections";
import { isSafeUrl } from "@/lib/assets";
import { MenuSpecView, menuSurfaceClass, type MenuDispatch, type MenuKit } from "./MenuSpecView";
import { openLinkInBrowser } from "@/lib/systemActions";
import { useCardMembership } from "@/hooks/useCardMembership";
import { useCollectionNameCheck, type CollectionNameCheck } from "@/hooks/useCollectionNameRefusal";
import { CardCollectionsContext } from "@/lib/cardCollections";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";
import { noFocusBackAfterPress, onPointerOffMenus, pointerIsOnMenu, useContextMenuPresence } from "@/lib/openMenus";
import { editorTableMenu, subscribeEditorTableMenu } from "@/lib/editorTableMenu";
import {
  cardConnectSpec,
  cardMenuItemId,
  cardMenuSpec,
  cardMenuTableCommand,
  runCardMenuItem,
  type CardMenuTableCommand,
} from "@/lib/cardMenuEntries";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import { currentInputAt, openMenuPanel, type MenuPanelSession } from "@/lib/menuPanelSource";
import { usePanelMenu } from "@/hooks/usePanelMenu";

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
  /** The menu stands at a point, its corner on it, not off a button's plate. */
  anchor?: ComponentProps<typeof DropdownMenuContent>["anchor"];
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

/** The feed card's `···` and ⌘K menus stand flush with their plate's right
 *  edge (`align="end"`). */
const PLATE_END_OPENER: MenuOpener = { kind: "plate", align: "end" };
const POINT_OPENER: MenuOpener = { kind: "point" };

/** The right click's opener, for the feed's handler. */
export const CARD_POINT_OPENER = POINT_OPENER;

/** What a card menu acts on: the card's own menu props and the app's check
 *  of a new collection's name. */
export type CardPanelCard<TBlock extends LightBlock | IndexedBlock> = CardMenuActionsProps<TBlock> & {
  checkName: CollectionNameCheck | undefined;
};

/** What Connect's picker acts on: the card and its collections' handlers. */
type CardPickerTarget = Pick<CardPanelCard<LightBlock | IndexedBlock>, "block" | "onToggleTag" | "onCreateAndAssign" | "checkName">;

/** Which of the card's menus: the whole menu of `More`, the right click and
 *  ⌘K, or Connect's picker alone, the card's `+`. */
type CardMenuKind = "menu" | "connect";

/** The commands of no table: one empty list, so the menu's description
 *  keeps its identity while no table is active. */
const NO_TABLE_COMMANDS: readonly CardMenuTableCommand[] = [];

function knownMembership(block: LightBlock | IndexedBlock): string[] {
  return "tags" in block ? block.tags : block.collections;
}

function activeTableCommands(slug: string): readonly CardMenuTableCommand[] {
  const table = editorTableMenu();
  return table?.slug === slug ? table.commands : NO_TABLE_COMMANDS;
}

/** The description of a card's menu (src/lib/cardMenuEntries.ts): the one
 *  the page's menu and the panel's draw. */
function cardSpec(
  kind: CardMenuKind,
  { block, tags, currentTag }: Pick<CardMenuActionsProps<LightBlock | IndexedBlock>, "block" | "tags" | "currentTag">,
  selectedTags: readonly string[],
  tableCommands: readonly CardMenuTableCommand[],
): MenuSpec {
  const picker = { card: block.slug, selected: selectedTags, tags, currentTag: currentTag ?? null };
  if (kind === "connect") return cardConnectSpec(picker);
  const disconnectFrom = currentTag && selectedTags.includes(currentTag) ? currentTag : null;
  return cardMenuSpec({ hasUrl: block.url != null && isSafeUrl(block.url), disconnectFrom, tableCommands, picker });
}

/** Carry out what Connect's picker asks with the card's own handlers. */
async function actOnPicker({ block, onToggleTag, onCreateAndAssign, checkName }: CardPickerTarget, action: MenuWidgetAction): Promise<MenuAnswer> {
  switch (action.kind) {
    case "toggle_collection": {
      // The feed's handler answers whether the change was made, as the
      // picker hears it.
      const made: unknown = await (onToggleTag(block.slug, action.collection, action.connected) as unknown);
      return { kind: "membership", made: typeof made === "boolean" ? made : null };
    }
    case "create_collection":
      await onCreateAndAssign(action.name, block.slug);
      return { kind: "done" };
    case "check_collection_name":
      return { kind: "name_refusal", reason: checkName ? await checkName(action.name) : null };
  }
}

/** Carry out a choice made in a card's menu with the card's own handlers:
 *  the menu on the page and the menu in the panel both come here. */
async function actOnCard<TBlock extends LightBlock | IndexedBlock>(card: CardPanelCard<TBlock>, action: MenuAction): Promise<MenuAnswer> {
  const { block } = card;
  if (action.kind === "run") {
    const tableCommand = cardMenuTableCommand(action.id);
    if (tableCommand !== null) {
      const table = editorTableMenu();
      if (table?.slug === block.slug) table.run(tableCommand);
      return { kind: "done" };
    }
    const item = cardMenuItemId(action.id);
    if (item !== null) {
      runCardMenuItem(item, {
        block,
        url: block.url != null && isSafeUrl(block.url) ? block.url : null,
        filePath: `${card.vaultPath}/${block.slug}.md`,
        currentTag: card.currentTag,
        onToggleTag: card.onToggleTag,
        onRequestRename: card.onRequestRename,
        onRequestDelete: card.onRequestDelete,
      });
    }
    return { kind: "done" };
  }
  return actOnPicker(card, action.action);
}

/**
 * TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
 * окне: проба»): open `card`'s menu in the menu panel now, from the input's
 * own handler. The panel draws the description the page's menu draws, with
 * the collections the feed knows; `CardMenuPanelUpdates` sends what the file
 * says once it is read. Each choice runs with the card's handlers as they
 * stand when it comes. The caller owns the menu it gets (МО41).
 */
export function startCardMenuPanel<TBlock extends LightBlock | IndexedBlock>(
  card: () => CardPanelCard<TBlock>,
  opening: {
    anchor: { x: number; y: number; width: number; height: number };
    opener: MenuOpener;
    byKey: boolean;
    /** When the input came, or null with no input's event at hand. */
    eventAt: number | null;
    contextMenu: boolean;
  },
  on: { onClosed: () => void; onRefused: () => void },
): MenuPanelSession {
  const now = card();
  const { x, y, width, height } = opening.anchor;
  return openMenuPanel(
    { x, y, width, height },
    opening.opener,
    { spec: cardSpec("menu", now, knownMembership(now.block), activeTableCommands(now.block.slug)), byKey: opening.byKey },
    { onAction: (action) => actOnCard(card(), action), onClosed: on.onClosed, onRefused: on.onRefused },
    { contextMenu: opening.contextMenu, eventAt: opening.eventAt },
  );
}

/** The description of a card's menu as it stands now, following the card.
 *  While `open`, the card's file is read for its collections (Е6.12). */
function useCardSpec(
  kind: CardMenuKind,
  { block, tags, currentTag }: Pick<CardMenuActionsProps<LightBlock | IndexedBlock>, "block" | "tags" | "currentTag">,
  open: boolean,
): MenuSpec {
  // The collections the feed knows, then what the file says (Е6.12).
  const selectedTags = useCardMembership(block, open);
  // The commands of the table active in the card's editor (SPEC_EDITING.md,
  // Л9.8, Л16).
  const tableMenu = useSyncExternalStore(subscribeEditorTableMenu, editorTableMenu, () => null);
  const tableCommands = tableMenu?.slug === block.slug ? tableMenu.commands : NO_TABLE_COMMANDS;
  return useMemo(
    () => cardSpec(kind, { block, tags, currentTag }, selectedTags, tableCommands),
    [kind, block, tags, currentTag, selectedTags, tableCommands],
  );
}

/**
 * The card's menu in the panel follows the card: what the file says of its
 * collections once read (Е6.12), the editor's table coming or going. It
 * draws nothing on the page, and it does not own the menu: it only sends
 * what changed (МО42).
 */
function CardMenuPanelUpdates({
  session,
  kind,
  block,
  tags,
  currentTag,
}: { session: MenuPanelSession; kind: CardMenuKind } & Pick<CardMenuActionsProps<LightBlock | IndexedBlock>, "block" | "tags" | "currentTag">) {
  const spec = useCardSpec(kind, { block, tags, currentTag }, true);
  const first = useRef(true);
  useEffect(() => {
    // The opening carried the first state already.
    if (first.current) {
      first.current = false;
      return;
    }
    session.update(spec);
  }, [session, spec]);
  return null;
}

/**
 * TRIAL: the feed card's right click menu, opened in the menu panel by the
 * click's own handler (`startCardMenuPanel`). While it is there this follows
 * the card; when the panel could not show it, the card's point menu opens on
 * the page at the same point.
 *
 * It does not own the menu and never closes it: the feed opened it, holds
 * its handle and closes it where it takes the menu away and when it unmounts
 * (SPEC_MENU_WINDOW.md, МО41, МО42). This component is there because the
 * menu is open, and React runs an effect's cleanup once on mount in
 * StrictMode: a closing in a cleanup here closed the menu the moment it
 * opened.
 */
export function CardPanelPointMenu<TBlock extends LightBlock | IndexedBlock>({
  session,
  onPage,
  x,
  y,
  onClose,
  ...actions
}: CardMenuActionsProps<TBlock> & { session: MenuPanelSession; onPage: boolean; x: number; y: number; onClose: () => void }) {
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
  return <CardMenuPanelUpdates session={session} kind="menu" block={actions.block} tags={actions.tags} currentTag={actions.currentTag} />;
}

/**
 * The card menu's entries on the page, to stand in a menu's surface: the
 * description the panel draws (`MenuSpecView`), its choices run with the
 * card's own handlers. `kit` is the surface's primitives: a dropdown's, or a
 * context menu's for the feed's right click.
 */
export function CardMenuRows<TBlock extends LightBlock | IndexedBlock>({
  menuOpen,
  kit,
  onKeyDownCapture,
  onTableCommand,
  ...card
}: CardMenuActionsProps<TBlock> & {
  menuOpen: boolean;
  kit?: MenuKit;
  onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
  /** A command of the editor's table was chosen. */
  onTableCommand?: () => void;
}) {
  const spec = useCardSpec("menu", card, menuOpen);
  const checkName = useCollectionNameCheck(undefined);
  // What a choice acts on when it comes: the props as they stand.
  const cardRef = useRef<CardPanelCard<TBlock>>({ ...card, checkName });
  cardRef.current = { ...card, checkName };
  const onTableCommandRef = useRef(onTableCommand);
  onTableCommandRef.current = onTableCommand;
  const dispatch = useCallback<MenuDispatch>((action) => {
    if (action.kind === "run" && cardMenuTableCommand(action.id) !== null) onTableCommandRef.current?.();
    return actOnCard(cardRef.current, action);
  }, []);
  return <MenuSpecView spec={spec} dispatch={dispatch} open={menuOpen} kit={kit} onKeyDownCapture={onKeyDownCapture} />;
}

/** A card's menu on the page: the surface of a dropdown with the card
 *  menu's entries in it. */
function CardMenuDropdownContent<TBlock extends LightBlock | IndexedBlock>({
  menuOpen,
  onCloseAutoFocus,
  onKeyDownCapture,
  plateOf,
  anchor,
  ...card
}: CardMenuDropdownContentProps<TBlock>) {
  // After a command of the editor's table the editor keeps the focus it
  // takes (SPEC_EDITING.md, Л9.8).
  const tableCommandRan = useRef(false);
  const noteTableCommand = useCallback(() => {
    tableCommandRan.current = true;
  }, []);

  return (
    <DropdownMenuContent
      align="end"
      anchor={anchor}
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
      <CardMenuRows {...card} menuOpen={menuOpen} onKeyDownCapture={onKeyDownCapture} onTableCommand={noteTableCommand} />
    </DropdownMenuContent>
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
  triggerSize,
  triggerShortcut,
  onCloseAutoFocus,
  plateOf,
  panelMenu = false,
}: CardMoreMenuProps<TBlock>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const lastOpenRequestSequenceRef = useRef(0);
  // The button owns the menu it opens in the menu panel (МО41).
  const panel = usePanelMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const checkName = useCollectionNameCheck(undefined);
  // What the panel's choices act on when they come: the props as they stand.
  const cardRef = useRef<CardPanelCard<TBlock>>({ block, vaultPath, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestRename, onRequestDelete, checkName });
  cardRef.current = { block, vaultPath, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestRename, onRequestDelete, checkName };
  const plateOfRef = useRef(plateOf);
  plateOfRef.current = plateOf;
  const closeRef = useRef<() => void>(() => undefined);

  const updateMenuOpen = useCallback((open: boolean) => {
    if (open && !menuOpenRef.current && panelMenu && triggerRef.current !== null) {
      // The request leaves now, in the input's handler, before React draws
      // (SPEC_MENU_WINDOW.md, МО19). When the panel takes no menu now, the
      // page's own opens below.
      const trigger = triggerRef.current;
      const card = cardRef.current;
      panel.open({
        anchor: (plateOfRef.current?.(trigger) ?? menuPlateOf(trigger)).getBoundingClientRect(),
        opener: PLATE_END_OPENER,
        menu: { spec: cardSpec("menu", card, knownMembership(card.block), activeTableCommands(card.block.slug)), byKey: lastInputIsKey() },
        onAction: (action) => actOnCard(cardRef.current, action),
        onClosed: () => closeRef.current(),
        contextMenu: false,
        eventAt: currentInputAt(),
      });
    } else if (!open) {
      panel.close();
    }
    menuOpenRef.current = open;
    setMenuOpen(open);
    onOpenChange?.(open);
  }, [onOpenChange, panel, panelMenu]);
  closeRef.current = () => updateMenuOpen(false);

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

  const inPanel = menuOpen && panel.session !== null;
  return (
    <DropdownMenu
      open={menuOpen && panel.session === null}
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
          {...(inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <CardMenuDropdownContent
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        menuOpen={menuOpen && panel.session === null}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        onCloseAutoFocus={topChromeInteraction ? topChromeTrigger.handleCloseAutoFocus : onCloseAutoFocus}
        onKeyDownCapture={handleMenuKeyDownCapture}
        plateOf={plateOf}
      />
      {inPanel && panel.session !== null && (
        <CardMenuPanelUpdates session={panel.session} kind="menu" block={block} tags={tags} currentTag={currentTag} />
      )}
    </DropdownMenu>
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

  // The menu's corner stands on the point of the click, with no offset, and
  // turns left at the page's right edge (SPEC_MENU_WINDOW.md, МО10, МО11,
  // МО69): the anchor is the point itself, a box of no size.
  return (
    <div
      className="fixed z-50 size-0"
      style={{ left: x, top: y }}
      data-card-point-menu-anchor=""
    >
      <DropdownMenu open={menuOpen} onOpenChange={updateMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="block size-0 min-h-0 min-w-0 border-0 bg-transparent p-0 opacity-0"
            data-card-point-menu-trigger=""
          />
        </DropdownMenuTrigger>
        <CardMenuDropdownContent
          block={block}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          menuOpen={menuOpen}
          anchor="point"
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
              panelMenu
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
            panelMenu
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
  panelMenu = false,
}: Pick<CardMenuActionsProps<LightBlock | IndexedBlock>, "block" | "tags" | "currentTag" | "onToggleTag" | "onCreateAndAssign"> & {
  className?: string;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes when the picker closes; the plus by default. */
  onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"];
  /** TRIAL: the picker opens in the menu panel when the menu mode is
   *  `window` (SPEC_MENU_WINDOW.md). */
  panelMenu?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  // The plus owns the menu it opens in the menu panel (МО41).
  const panel = usePanelMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const checkName = useCollectionNameCheck(undefined);
  // What the picker's choices act on when they come: the props as they stand.
  const targetRef = useRef<CardPickerTarget & Pick<CardMenuActionsProps<LightBlock | IndexedBlock>, "tags" | "currentTag">>({ block, tags, currentTag, onToggleTag, onCreateAndAssign, checkName });
  targetRef.current = { block, tags, currentTag, onToggleTag, onCreateAndAssign, checkName };
  const closeRef = useRef<() => void>(() => undefined);
  const onPage = open && panel.session === null;
  // The picker shows the card's collections ticked: the feed's, then what
  // the file says when it opens (Е6.12).
  const spec = useCardSpec("connect", { block, tags, currentTag }, onPage);
  // The picker is the whole menu: its widget's asks are its only choices.
  const act = useCallback(
    (action: MenuAction): Promise<MenuAnswer> =>
      action.kind === "widget" ? actOnPicker(targetRef.current, action.action) : Promise.resolve({ kind: "done" }),
    [],
  );

  const updateOpen = useCallback((next: boolean) => {
    if (next && !openRef.current && panelMenu && triggerRef.current !== null) {
      // Asked for now, in the input's handler (SPEC_MENU_WINDOW.md, МО19).
      // When the panel takes no menu now, the page's own opens below.
      const target = targetRef.current;
      panel.open({
        anchor: menuPlateOf(triggerRef.current).getBoundingClientRect(),
        opener: PLATE_END_OPENER,
        menu: { spec: cardSpec("connect", target, knownMembership(target.block), NO_TABLE_COMMANDS), byKey: lastInputIsKey() },
        onAction: act,
        onClosed: () => closeRef.current(),
        contextMenu: false,
        eventAt: currentInputAt(),
      });
    } else if (!next) {
      panel.close();
    }
    openRef.current = next;
    setOpen(next);
    onOpenChange?.(next);
  }, [act, onOpenChange, panel, panelMenu]);
  closeRef.current = () => updateOpen(false);

  const inPanel = open && panel.session !== null;
  return (
    <DropdownMenu open={onPage} onOpenChange={updateOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="raised"
          size="icon-xs"
          aria-label="Connect"
          className={className}
          data-card-hover-connect=""
          // The picker is open in the panel: the plus looks as it does with
          // its picker open on the page.
          {...(inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
        >
          <Plus aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        widthRole={spec.role}
        className={menuSurfaceClass(spec.role)}
        align="end"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <MenuSpecView spec={spec} dispatch={act} open={onPage} />
      </DropdownMenuContent>
      {inPanel && panel.session !== null && (
        <CardMenuPanelUpdates session={panel.session} kind="connect" block={block} tags={tags} currentTag={currentTag} />
      )}
    </DropdownMenu>
  );
}
