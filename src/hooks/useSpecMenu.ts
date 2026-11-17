// A menu described as data and opened by the component that owns it
// (SPEC_MENU_WINDOW.md, МО19, МО26, МО41): in the menu panel when the panel
// takes it, else on the owner's page, where the owner draws the same
// description (`MenuSpecView`). The owner calls `show` in the input's own
// handler and gives the description as it stands now; while the menu is in
// the panel, every later description goes there as it changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MenuAction, MenuAnswer, MenuOpener, MenuSpec, ScreenRect } from "@/types";
import { currentInputAt } from "@/lib/menuPanelSource";
import { usePanelMenu } from "./usePanelMenu";

export interface SpecMenuAnchor {
  /** The anchor in this page: a button's plate, or the point of a right
   *  click as a rectangle of no size. */
  rect: ScreenRect;
  opener: MenuOpener;
  /** A key opened the menu. */
  byKey: boolean;
  /** A right click opened it: it also holds the pointer's answers on the
   *  page. */
  contextMenu: boolean;
}

export interface SpecMenu {
  /** The menu is open, in the panel or on the page. */
  open: boolean;
  /** It is drawn on the page: the owner's surface is open. */
  onPage: boolean;
  /** It is in the menu panel: the owner's button looks open. */
  inPanel: boolean;
  /** Open the menu at `anchor`. */
  show: (anchor: SpecMenuAnchor) => void;
  /** The owner takes the menu away, or its surface on the page closed. */
  hide: () => void;
}

export function useSpecMenu({
  spec,
  largest,
  act,
  onOpenChange,
}: {
  /** The menu as it stands now. */
  spec: MenuSpec;
  /** The menu at its largest while open, when it may grow past `spec`. */
  largest?: MenuSpec;
  /** Carry out a choice made in the menu. */
  act: (action: MenuAction) => Promise<MenuAnswer>;
  onOpenChange?: (open: boolean) => void;
}): SpecMenu {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const panel = usePanelMenu();
  const { open: openInPanel, close: closeInPanel, session } = panel;
  // What an opening and a choice read when they come: the props as they stand.
  const now = useRef({ spec, largest, act, onOpenChange });
  now.current = { spec, largest, act, onOpenChange };

  const setOpenTo = useCallback((next: boolean) => {
    if (openRef.current === next) return;
    openRef.current = next;
    setOpen(next);
    now.current.onOpenChange?.(next);
  }, []);

  const show = useCallback((anchor: SpecMenuAnchor) => {
    // When the panel takes no menu now, or refuses it, the menu is drawn on
    // the page: `open` with no session.
    openInPanel({
      anchor: anchor.rect,
      opener: anchor.opener,
      menu: { spec: now.current.spec, largest: now.current.largest, byKey: anchor.byKey },
      onAction: (action) => now.current.act(action),
      onClosed: () => setOpenTo(false),
      contextMenu: anchor.contextMenu,
      eventAt: currentInputAt(),
    });
    setOpenTo(true);
  }, [openInPanel, setOpenTo]);

  const hide = useCallback(() => {
    closeInPanel();
    setOpenTo(false);
  }, [closeInPanel, setOpenTo]);

  // The menu in the panel follows the description: the opening carried the
  // first one, every other goes as it changes.
  const sent = useRef<{ session: typeof session; spec: MenuSpec } | null>(null);
  useEffect(() => {
    if (session === null) {
      sent.current = null;
      return;
    }
    if (sent.current?.session !== session) {
      sent.current = { session, spec };
      return;
    }
    if (sent.current.spec === spec) return;
    sent.current = { session, spec };
    session.update(spec);
  }, [session, spec]);

  return useMemo(
    () => ({ open, onPage: open && session === null, inPanel: open && session !== null, show, hide }),
    [open, session, show, hide],
  );
}
