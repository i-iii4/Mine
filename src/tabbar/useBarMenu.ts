// The bar's side of a menu in the menu panel (SPEC_MENU_WINDOW.md, МО19,
// МО41, МО68а). The bar owns the menu it opens: one at a time, closed when
// the bar takes it away and when it unmounts. The bar page is one row tall,
// so a menu the panel does not take cannot open on the page as elsewhere:
// the system's own menu shows instead, when the menu mode is `web` and when
// the panel refuses.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentInputAt, menuPanelUsable, openMenuPanel, type MenuPanelSession } from "@/lib/menuPanelSource";
import type { MenuAction, MenuOpener, MenuSpec, ScreenRect } from "@/types";

export interface BarMenuRequest {
  /** Which of the bar's menus this is: the bar tells its open menu by it. */
  key: string;
  /** The anchor in the bar's page: a button's plate, or the point of a
   *  right click as a rectangle of no size. */
  anchor: ScreenRect;
  opener: MenuOpener;
  spec: MenuSpec;
  /** A key opened the menu. */
  byKey: boolean;
  /** A right click opened it. */
  contextMenu: boolean;
  /** Carry out a choice made in the panel. */
  onAction: (action: MenuAction) => void;
  /** Show the system's menu: the panel takes none now, or refused this one. */
  native: () => void;
}

export interface BarMenu {
  /** The key of the menu open in the panel, or null. */
  openKey: string | null;
  /** Open a menu, in the input's own handler. */
  open: (request: BarMenuRequest) => void;
  /** Send what changed in the open menu: the whole menu again. */
  update: (spec: MenuSpec) => void;
  /** The bar takes its menu away. */
  close: () => void;
}

export function useBarMenu(): BarMenu {
  const sessionRef = useRef<MenuPanelSession | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const open = useCallback((request: BarMenuRequest) => {
    if (!menuPanelUsable()) {
      request.native();
      return;
    }
    const over = () => {
      if (sessionRef.current !== opened) return false;
      sessionRef.current = null;
      setOpenKey(null);
      return true;
    };
    const opened: MenuPanelSession = openMenuPanel(
      request.anchor,
      request.opener,
      { spec: request.spec, byKey: request.byKey },
      {
        onAction: (action) => {
          request.onAction(action);
          return { kind: "done" };
        },
        onClosed: () => {
          over();
        },
        // The panel could not show it: the system's menu does.
        onRefused: () => {
          over();
          request.native();
        },
      },
      { contextMenu: request.contextMenu, eventAt: currentInputAt() },
    );
    sessionRef.current = opened;
    setOpenKey(request.key);
  }, []);

  const update = useCallback((spec: MenuSpec) => {
    sessionRef.current?.update(spec);
  }, []);

  const close = useCallback(() => {
    const owned = sessionRef.current;
    if (owned === null) return;
    sessionRef.current = null;
    setOpenKey(null);
    owned.close("source");
  }, []);

  // The bar unmounts: its menu goes with it. In StrictMode this cleanup
  // runs once on mount, when no menu is open yet.
  useEffect(() => () => sessionRef.current?.close("source"), []);

  return useMemo(() => ({ openKey, open, update, close }), [openKey, open, update, close]);
}
