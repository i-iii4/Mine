// A search result row's commands (SPEC_SEARCH_OVERLAY.md, «Команды строки»):
// Connect, Source and More in a row at the row's right end. They are the feed
// card's own controls (CardHoverMenu.tsx), so the row does what the card does.

import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  CardConnectMenu,
  CardMoreMenu,
  CardSourceButton,
} from "@/components/CardHoverMenu";
import { isSafeUrl } from "@/lib/assets";
import { commandById } from "@/lib/commandRegistry";
import { cn } from "@/lib/utils";
import type { LightBlock, TagCount } from "@/types";

/** An `icon-xs` button is 24 px; the card sets its buttons 4 px apart. */
const ACTION_BUTTON_PX = 24;
const ACTION_GAP_PX = 4;
/** Between the row's text and the first button: the row's own gap (`gap-2`). */
const TEXT_TO_ACTIONS_PX = 8;

/** Source is offered under the card's own check: a safe link. */
export function searchRowHasSource(block: LightBlock): boolean {
  return block.url != null && isSafeUrl(block.url);
}

/** What the row's text leaves free at its end while the buttons show. */
export function searchRowActionsReservePx(block: LightBlock): number {
  const buttons = searchRowHasSource(block) ? 3 : 2;
  return buttons * ACTION_BUTTON_PX + (buttons - 1) * ACTION_GAP_PX + TEXT_TO_ACTIONS_PX;
}

type CloseAutoFocus = NonNullable<ComponentProps<typeof CardConnectMenu>["onCloseAutoFocus"]>;

interface SearchResultRowActionsProps {
  block: LightBlock;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  /** The pointer is on the row. An open menu shows the buttons as well. */
  visible: boolean;
  /** Counts ⌘K presses: each one opens or closes the row's More menu. */
  moreMenuRequestSequence: number;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
  /** Whether one of the row's menus is open. */
  onMenuOpenChange: (slug: string, open: boolean) => void;
  /** A closing menu sends focus here instead of to its button. */
  onMenuCloseAutoFocus: CloseAutoFocus;
}

export function SearchResultRowActions({
  block,
  vaultPath,
  tags,
  currentTag,
  visible,
  moreMenuRequestSequence,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onMenuOpenChange,
  onMenuCloseAutoFocus,
}: SearchResultRowActionsProps) {
  // A press counted before these buttons mounted was meant for another row:
  // the menu answers only to the presses that come after.
  const [requestBase] = useState(moreMenuRequestSequence);
  const moreMenuRequest = Math.max(0, moreMenuRequestSequence - requestBase);
  const [moreOpen, setMoreOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const menuOpen = moreOpen || connectOpen;
  const shown = visible || menuOpen;

  // The overlay holds the row while its menu is open. A row that goes away
  // with its menu open (deleted from that menu) lets go of it.
  const slug = block.slug;
  const reportedRef = useRef<{ slug: string; open: boolean }>({ slug, open: false });
  const onMenuOpenChangeRef = useRef(onMenuOpenChange);
  onMenuOpenChangeRef.current = onMenuOpenChange;
  useEffect(() => {
    if (reportedRef.current.open === menuOpen) return;
    reportedRef.current = { slug, open: menuOpen };
    onMenuOpenChangeRef.current(slug, menuOpen);
  }, [menuOpen, slug]);
  useEffect(() => () => {
    if (reportedRef.current.open) onMenuOpenChangeRef.current(reportedRef.current.slug, false);
  }, []);

  return (
    <div
      className={cn(
        // Over the row's right end, where the text stops short of it. The
        // card's answer to the pointer: in over the fade-in token, out over
        // the shorter fade-out token, both zero under reduced motion
        // (SPEC_CARD_STATES.md, С7.6, С8.4); no lift, nothing moves.
        "absolute inset-y-0 right-2 flex items-center gap-1 transition-opacity",
        shown
          ? "opacity-100 duration-[var(--hover-intent-fade-in)] starting:opacity-0"
          : "pointer-events-none opacity-0 duration-[var(--hover-intent-fade-out)]",
      )}
      data-search-row-actions=""
      data-visible={shown ? "true" : "false"}
      // Hidden, the buttons are out of reach of Tab and of assistive
      // technology; the keyboard reaches the menu with ⌘K.
      inert={!shown}
      aria-hidden={shown ? undefined : true}
    >
      <CardConnectMenu
        block={block}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onOpenChange={setConnectOpen}
        onCloseAutoFocus={onMenuCloseAutoFocus}
      />
      {searchRowHasSource(block) && <CardSourceButton url={block.url!} />}
      <CardMoreMenu
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        openRequestSequence={moreMenuRequest}
        triggerVariant="raised"
        triggerSize="icon-xs"
        // Here ⌘K opens the menu of the row under the pointer: the pointer
        // and the arrows move one active row.
        triggerShortcut={commandById("element-menu").combo}
        onOpenChange={setMoreOpen}
        onCloseAutoFocus={onMenuCloseAutoFocus}
      />
    </div>
  );
}
