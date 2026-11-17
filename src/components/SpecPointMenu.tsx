// A menu described as data that a right click opens (SPEC_MENU_WINDOW.md,
// МО10, МО19, МО41, МО68): it stays mounted and opens through its handle,
// in the menu panel when the menu mode is `window`, the panel asked the
// moment `open` is called, else on the page at the same point. The menu's
// corner stands on the point either way: on the page it is a dropdown with
// an anchor of no size, since Radix's context menu keeps a shift of 2 px.
// The component owns the menu it opens, and is there whether a menu is open
// or not: React's trial run of its mount in StrictMode finds no menu to
// close.

import { useImperativeHandle, useState, type Ref } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSpecMenu } from "@/hooks/useSpecMenu";
import { lastInputIsKey } from "@/lib/motionInput";
import { useContextMenuPresence, useMenuGuard } from "@/lib/openMenus";
import type { MenuAction, MenuAnswer, MenuSpec } from "@/types";
import { MenuSpecView, menuSurfaceClass } from "./MenuSpecView";

export interface SpecPointMenuHandle {
  /** Open the menu at `point` of the page, in the input's own handler. */
  open: (point: { x: number; y: number }) => void;
  /** Its owner takes the menu away. */
  close: () => void;
}

export function SpecPointMenu({
  handleRef,
  spec,
  largest,
  act,
  onOpenChange,
  surface,
}: {
  handleRef: Ref<SpecPointMenuHandle>;
  /** The menu as it stands now. */
  spec: MenuSpec;
  /** The menu at its largest while open, when it may grow past `spec`. */
  largest?: MenuSpec;
  /** Carry out a choice made in the menu. */
  act: (action: MenuAction) => Promise<MenuAnswer>;
  onOpenChange?: (open: boolean) => void;
  /** What marks the menu's surface on the page. */
  surface?: Record<`data-${string}`, string>;
}) {
  const { show, hide, onPage } = useSpecMenu({ spec, largest, act, onOpenChange });
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

  useImperativeHandle(handleRef, () => ({
    open: (at) => {
      setPoint(at);
      // A chord may open it too (the sidebar's ⌘K on a row): the menu then
      // lands at once and lights its first row.
      show({ rect: { x: at.x, y: at.y, width: 0, height: 0 }, opener: { kind: "point" }, byKey: lastInputIsKey(), contextMenu: true });
    },
    close: hide,
  }), [show, hide]);

  // A right click opened it: a context menu in all but its anchor. The first
  // press outside only closes it, as every menu's (src/lib/openMenus.ts);
  // the surface goes with the menu, so this owner keeps the guard there.
  useContextMenuPresence(onPage);
  useMenuGuard();

  if (!onPage || point === null) return null;
  return (
    <div className="fixed z-50 size-0" style={{ left: point.x, top: point.y }}>
      <DropdownMenu
        open
        onOpenChange={(next) => {
          if (!next) hide();
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="block size-0 min-h-0 min-w-0 border-0 bg-transparent p-0 opacity-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          anchor="point"
          widthRole={spec.role}
          className={menuSurfaceClass(spec.role)}
          onCloseAutoFocus={(event) => event.preventDefault()}
          {...surface}
        >
          <MenuSpecView spec={spec} dispatch={act} open />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
