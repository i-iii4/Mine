import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useGroupSelectionMenu, type GroupSelectionMenuInput } from "@/hooks/useGroupSelectionMenu";
import { SpecPointMenu, type SpecPointMenuHandle } from "./SpecPointMenu";

/** What marks the selection's right click menu on the page. */
const SELECTION_MENU_SURFACE = { "data-feed-grid-selection-context-menu": "" } as const;

/// The right-click menu of a group selection: the selection's one
/// description (src/lib/groupSelectionMenu.ts), opened at the point of the
/// click.
///
/// Every command here acts on the whole selection, so the single-card commands
/// are absent by construction rather than disabled: `Reveal in Finder`,
/// `Copy Path` and `Rename…` address one file, and `Source` opens one URL.
/// Applying them to a selection would either pick a card silently or spray the
/// desktop with windows, and a menu that offers neither is the honest one.
///
/// The delete confirmation lives in the grid, not here: the menu is gone the
/// moment it closes, and a dialog mounted inside it would vanish with the
/// click that opened it.

/** The handle of `GroupSelectionPointMenuHost`. */
export interface GroupSelectionPointMenuHandle {
  /** Open the selection's menu at `point` of the page. */
  open: (point: { x: number; y: number }) => void;
}

/**
 * The selection's right click menu for the menu panel: it stays mounted and
 * opens through its handle, in the panel when the menu mode is `window`,
 * else on the page at the same point, the menu's corner on the point either
 * way (`SpecPointMenu`; SPEC_MENU_WINDOW.md, МО10, МО19).
 */
export function GroupSelectionPointMenuHost({
  handleRef,
  onOpenChange,
  ...props
}: GroupSelectionMenuInput & {
  handleRef: Ref<GroupSelectionPointMenuHandle>;
  /** The menu opened, or closed. */
  onOpenChange?: (open: boolean) => void;
}) {
  const menu = useGroupSelectionMenu("menu", props);
  const { setOpen } = menu;
  const reportOpen = useCallback((open: boolean) => {
    setOpen(open);
    onOpenChange?.(open);
  }, [setOpen, onOpenChange]);
  const pointMenu = useRef<SpecPointMenuHandle>(null);

  useImperativeHandle(handleRef, () => ({ open: (at) => pointMenu.current?.open(at) }), []);

  // The selection emptied under an open menu: nothing is left to act on.
  const empty = props.selectedBlocks.length === 0;
  useEffect(() => {
    if (empty) pointMenu.current?.close();
  }, [empty]);

  return (
    <SpecPointMenu
      handleRef={pointMenu}
      spec={menu.spec}
      largest={menu.largest}
      act={menu.act}
      onOpenChange={reportOpen}
      surface={SELECTION_MENU_SURFACE}
    />
  );
}
