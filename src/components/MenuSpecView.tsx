// The one component that draws a menu described as data (`MenuSpec`,
// src-tauri/src/menu_panel/spec.rs; SPEC_MENU_WINDOW.md, МО16, МО23, МО27).
//
// A page describes its menu, and this draws the description's entries with
// the menu primitives, inside a menu's surface: in the menu panel's page and
// on the page the menu came from alike, so a menu looks and answers the same
// in both. Every choice leaves as an action that names its entry
// (`dispatch`): on the page it goes straight to the page's handlers, in the
// panel through the backend to the same handlers. What lives only while the
// menu is open stays here and in the widgets: which submenu is open, a
// search field's query, the row under the pointer.
//
// The entries drawn are the ones the card menus hold; a menu with another
// kind of entry brings the kind with it (SPEC_MENU_WINDOW.md, section 14).

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { ExternalLink, Plus, Trash2, Unlink, type LucideIcon } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import type { FloatingMenuWidth } from "@/lib/floatingLayer";
import type { MenuAction, MenuAnswer, MenuEntry, MenuIcon, MenuSpec, MenuWidget, MenuWidthRole } from "@/types";
import { COLLECTION_PICKER_CONTENT_CLASS, CollectionPicker } from "./CollectionPicker";

/** Send a choice to the page the menu came from: its answer, or null when
 *  the menu closed before one came. */
export type MenuDispatch = (action: MenuAction) => Promise<MenuAnswer | null>;

/**
 * The primitives a menu's entries are made of. A menu on a page stands in a
 * dropdown's surface or in a context menu's, and a row of one has no menu
 * inside the other: React throws on it.
 */
export interface MenuKit {
  Item: ComponentType<{
    variant?: "default" | "destructive" | "detach";
    onSelect?: (event: Event) => void;
    children?: ReactNode;
  }>;
  Separator: ComponentType;
  Sub: ComponentType<{ open?: boolean; onOpenChange?: (open: boolean) => void; children?: ReactNode }>;
  SubTrigger: ComponentType<{ ref?: Ref<HTMLDivElement>; children?: ReactNode }>;
  SubContent: ComponentType<{
    widthRole?: FloatingMenuWidth;
    className?: string;
    collisionPadding?: number;
    onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
    children?: ReactNode;
  }>;
}

export const DROPDOWN_MENU_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export const CONTEXT_MENU_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

const MENU_ICONS: Record<MenuIcon, LucideIcon> = {
  plus: Plus,
  external: ExternalLink,
  unlink: Unlink,
  trash: Trash2,
};

/**
 * The class of the surface a menu of `role` stands in, beside the
 * surface's own: a list under a search field fills its surface with no
 * inset, the field and the list each keeping its own.
 */
export function menuSurfaceClass(role: MenuWidthRole): string | undefined {
  return role === "search" ? COLLECTION_PICKER_CONTENT_CLASS : undefined;
}

function IconSlot({ icon }: { icon: MenuIcon | null }) {
  if (icon === null) return <MenuIconSlot />;
  const Icon = MENU_ICONS[icon];
  return (
    <MenuIconSlot>
      <Icon className="size-[13px]" />
    </MenuIconSlot>
  );
}

type CollectionPickerWidget = Extract<MenuWidget, { kind: "collection_picker" }>;

/** The picker of a card's collections: its changes leave as the widget's
 *  actions. The handlers keep their identity while the menu is open: the
 *  picker asks about a typed name again whenever its check changes. */
function CollectionPickerView({
  id,
  widget,
  dispatch,
  onRequestClose,
}: {
  id: string;
  widget: CollectionPickerWidget;
  dispatch: MenuDispatch;
  onRequestClose?: () => void;
}) {
  // The picker shows a change at once and takes it back on a `false`: a
  // choice with no answer was not made.
  const toggle = useCallback(
    (_card: string, collection: string, connected: boolean) =>
      dispatch({ kind: "widget", id, action: { kind: "toggle_collection", collection, connected } }).then((answer) =>
        answer === null ? false : answer.kind === "membership" && answer.made !== null ? answer.made : undefined),
    [dispatch, id],
  );
  const create = useCallback(
    (name: string) => dispatch({ kind: "widget", id, action: { kind: "create_collection", name } }),
    [dispatch, id],
  );
  const checkName = useCallback(
    (name: string) =>
      dispatch({ kind: "widget", id, action: { kind: "check_collection_name", name } }).then((answer) =>
        answer?.kind === "name_refusal" ? answer.reason : null),
    [dispatch, id],
  );
  const tags = useMemo(() => widget.collections.map(({ name, count }) => ({ tag: name, count })), [widget.collections]);
  return (
    <CollectionPicker
      blockSlug={widget.card}
      selectedTags={widget.selected}
      tags={tags}
      currentTag={widget.current ?? undefined}
      onToggleTag={toggle}
      onCreateAndAssign={create}
      onCheckName={checkName}
      stopKeyPropagation
      onRequestClose={onRequestClose}
    />
  );
}

function WidgetView({
  id,
  widget,
  dispatch,
  onRequestClose,
}: {
  id: string;
  widget: MenuWidget;
  dispatch: MenuDispatch;
  /** Escape with no query closes what holds the widget: its submenu. A
   *  widget that is the whole menu has none, and Escape closes the menu. */
  onRequestClose?: () => void;
}) {
  switch (widget.kind) {
    case "collection_picker":
      return <CollectionPickerView id={id} widget={widget} dispatch={dispatch} onRequestClose={onRequestClose} />;
  }
}

export interface MenuSpecViewProps {
  spec: MenuSpec;
  dispatch: MenuDispatch;
  /** The menu is open: a menu that closed starts again with its submenus
   *  shut. */
  open: boolean;
  /** The surface's primitives; a dropdown's unless given. */
  kit?: MenuKit;
  /** The submenus' distance from the edges, the wrappers' own unless given. */
  collisionPadding?: number;
  /** Heard before any row of the menu or of a submenu hears a key. */
  onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
}

/**
 * The entries of `spec`, to stand inside a menu's surface
 * (`DropdownMenuContent`, `ContextMenuContent`).
 */
export function MenuSpecView({ spec, dispatch, open, kit = DROPDOWN_MENU_KIT, collisionPadding, onKeyDownCapture }: MenuSpecViewProps) {
  // One submenu at a time, by its entry's id.
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!open) setOpenSubmenu(null);
  }, [open]);

  const setTrigger = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) triggers.current.set(id, node);
    else triggers.current.delete(id);
  }, []);

  const run = (id: string) => {
    void dispatch({ kind: "run", id });
  };

  const entryOf = (entry: MenuEntry, index: number, submenu: string | null): ReactNode => {
    switch (entry.kind) {
      case "separator":
        return <kit.Separator key={`separator-${index}`} />;
      case "item":
        return (
          <kit.Item key={entry.id} variant={entry.variant} onSelect={() => run(entry.id)}>
            <IconSlot icon={entry.icon} />
            {entry.truncate ? <span className="min-w-0 truncate">{entry.label}</span> : entry.label}
          </kit.Item>
        );
      case "widget":
        return (
          <WidgetView
            key={entry.id}
            id={entry.id}
            widget={entry.widget}
            dispatch={dispatch}
            onRequestClose={submenu === null
              ? undefined
              : () => {
                // Escape in a submenu's widget closes the submenu alone and
                // gives the focus back to its row.
                setOpenSubmenu((current) => (current === submenu ? null : current));
                requestAnimationFrame(() => triggers.current.get(submenu)?.focus());
              }}
          />
        );
      case "submenu":
        return (
          <kit.Sub
            key={entry.id}
            open={openSubmenu === entry.id}
            onOpenChange={(next) => setOpenSubmenu((current) => (next ? entry.id : current === entry.id ? null : current))}
          >
            <kit.SubTrigger ref={(node) => setTrigger(entry.id, node)}>
              <IconSlot icon={entry.icon} />
              {entry.label}
            </kit.SubTrigger>
            <kit.SubContent
              widthRole={entry.content.role}
              className={menuSurfaceClass(entry.content.role)}
              collisionPadding={collisionPadding}
              onKeyDownCapture={onKeyDownCapture}
            >
              {entry.content.entries.map((inner, innerIndex) => entryOf(inner, innerIndex, entry.id))}
            </kit.SubContent>
          </kit.Sub>
        );
    }
  };

  return spec.entries.map((entry, index) => entryOf(entry, index, null));
}
