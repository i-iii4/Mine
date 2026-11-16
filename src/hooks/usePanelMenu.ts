// The owner's side of a menu in the menu panel (SPEC_MENU_WINDOW.md, МО41,
// МО42). The component that opens a menu owns it: it holds the menu's handle,
// closes the menu where it takes it away itself, and closes it when it
// unmounts. This hook is that ownership for a component: one menu at a time,
// its handle in a ref, the closing on unmount in an effect with no
// dependencies. In StrictMode that effect's cleanup runs once on the owner's
// mount, when no menu is open yet. A component that is there because the
// menu is open is no owner and closes nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MenuOpener, MenuPanelCloseReason, ScreenRect } from "@/types";
import { menuPanelUsable, openMenuPanel, type MenuPanelHandlers, type MenuPanelMenu, type MenuPanelSession } from "@/lib/menuPanelSource";

export interface PanelMenuRequest {
  /** The anchor in this page: a button's plate, or the point of a right
   *  click as a rectangle of no size. */
  anchor: ScreenRect;
  opener: MenuOpener;
  menu: MenuPanelMenu;
  onAction: MenuPanelHandlers["onAction"];
  /** The menu showed in the panel and closed, not by `close` here. */
  onClosed: (reason: MenuPanelCloseReason) => void;
  /** A right click's menu also holds the pointer's answers on the page. */
  contextMenu: boolean;
  /** When the input came, or null with no input's event at hand. */
  eventAt: number | null;
}

export interface PanelMenu {
  /** The handle of the menu while it is in the panel, else null: closed, or
   *  on the page because the panel could not take it. */
  session: MenuPanelSession | null;
  /**
   * Ask the panel for a menu, in the input's own handler. False when no menu
   * goes to the panel now: the owner opens it on its page. True when the
   * panel was asked: if it then refuses, `session` becomes null and the
   * owner's menu opens on the page.
   */
  open: (request: PanelMenuRequest) => boolean;
  /** The owner takes the menu away. */
  close: () => void;
}

export function usePanelMenu(): PanelMenu {
  const [session, setSession] = useState<MenuPanelSession | null>(null);
  const sessionRef = useRef<MenuPanelSession | null>(null);

  const forget = useCallback((over: MenuPanelSession) => {
    if (sessionRef.current !== over) return;
    sessionRef.current = null;
    setSession(null);
  }, []);

  const open = useCallback((request: PanelMenuRequest): boolean => {
    if (!menuPanelUsable()) return false;
    const opened: MenuPanelSession = openMenuPanel(
      request.anchor,
      request.opener,
      request.menu,
      {
        onAction: request.onAction,
        onClosed: (reason) => {
          forget(opened);
          request.onClosed(reason);
        },
        // The panel could not show it: with no session the owner's menu
        // opens on the page.
        onRefused: () => forget(opened),
      },
      { contextMenu: request.contextMenu, eventAt: request.eventAt },
    );
    sessionRef.current = opened;
    setSession(opened);
    return true;
  }, [forget]);

  const close = useCallback(() => {
    const owned = sessionRef.current;
    if (owned === null) return;
    sessionRef.current = null;
    setSession(null);
    owned.close("source");
  }, []);

  // The owner unmounts: its menu goes with it.
  useEffect(() => () => sessionRef.current?.close("source"), []);

  return useMemo(() => ({ session, open, close }), [session, open, close]);
}
