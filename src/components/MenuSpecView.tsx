// The one component that draws a menu described as data (`MenuSpec`,
// src-tauri/src/menu_panel/spec.rs; SPEC_MENU_WINDOW.md, МО16, МО23, МО27).
//
// A page describes its menu, and this draws the description's entries with
// the dropdown's primitives, inside a dropdown's surface (a menu a right
// click opens is a dropdown off the point too, МО68): in the menu panel's
// page and on the page the menu came from alike, so a menu looks and answers the same
// in both. Every choice leaves as an action that names its entry
// (`dispatch`): on the page it goes straight to the page's handlers, in the
// panel through the backend to the same handlers. What lives only while the
// menu is open stays here and in the widgets: which submenu is open, a
// search field's query, the row under the pointer.
//
// The entries drawn are the ones the menus moved into the panel hold: a
// card's, a selection's, those of an open card's content and the chrome's;
// a menu with another kind of entry brings the kind with it
// (SPEC_MENU_WINDOW.md, section 14).

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ExternalLink, FolderOpen, Pencil, Plus, Trash2, Unlink, type LucideIcon } from "lucide-react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import type { MenuAction, MenuAnswer, MenuEntry, MenuIcon, MenuSpec, MenuWidget, MenuWidgetAction, MenuWidthRole } from "@/types";
import { BatchCollectionPicker, COLLECTION_PICKER_CONTENT_CLASS, CollectionPicker } from "./CollectionPicker";
import { NewCardCollectionPicker } from "./NewCardCollectionPicker";
import { SpaceList } from "./SpaceList";

/** Send a choice to the page the menu came from: its answer, or null when
 *  the menu closed before one came. */
export type MenuDispatch = (action: MenuAction) => Promise<MenuAnswer | null>;

const MENU_ICONS: Record<MenuIcon, LucideIcon> = {
  plus: Plus,
  external: ExternalLink,
  unlink: Unlink,
  trash: Trash2,
  pencil: Pencil,
  folder: FolderOpen,
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

type BatchCollectionPickerWidget = Extract<MenuWidget, { kind: "batch_collection_picker" }>;

/** The picker of a selection's collections. A collection is ticked when
 *  every selected card is in it, which is all the description says: the
 *  picker reads it as each card being in exactly those. */
function BatchCollectionPickerView({
  id,
  widget,
  dispatch,
  onRequestClose,
}: {
  id: string;
  widget: BatchCollectionPickerWidget;
  dispatch: MenuDispatch;
  onRequestClose?: () => void;
}) {
  const connect = useCallback(
    (_cards: string[], collection: string, connected: boolean) =>
      dispatch({ kind: "widget", id, action: { kind: "connect_cards", collection, connected } }).then((answer) =>
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
  const lookup = useMemo(() => new Map(widget.cards.map((card) => [card, widget.in_all])), [widget.cards, widget.in_all]);
  return (
    <BatchCollectionPicker
      selectedSlugs={widget.cards}
      tags={tags}
      tagLookup={lookup}
      onBatchSetTag={connect}
      onCreateAndAssign={create}
      onCheckName={checkName}
      onRequestClose={onRequestClose}
    />
  );
}

type NewCardPickerWidget = Extract<MenuWidget, { kind: "new_card_picker" }>;

/** The picker of a new card's collection: a choice leaves as the widget's
 *  action, and the picker shows why the card could not be made. A choice
 *  with no answer says nothing: the menu closed. */
function NewCardPickerView({
  id,
  widget,
  dispatch,
}: {
  id: string;
  widget: NewCardPickerWidget;
  dispatch: MenuDispatch;
}) {
  const choose = useCallback(
    (collection: string | null, create: boolean) =>
      dispatch({ kind: "widget", id, action: { kind: "create_card", collection, new_collection: create } }).then((answer) =>
        answer?.kind === "failed" ? answer.message : null),
    [dispatch, id],
  );
  return <NewCardCollectionPicker collections={widget.collections} current={widget.current} onChoose={choose} />;
}

type SpaceListWidget = Extract<MenuWidget, { kind: "space_list" }>;

/** The list of spaces: what a row or a button of it asks leaves as the
 *  widget's action, for the page the menu came from to carry out. */
function SpaceListView({
  id,
  widget,
  dispatch,
  open,
}: {
  id: string;
  widget: SpaceListWidget;
  dispatch: MenuDispatch;
  open: boolean;
}) {
  const ask = useCallback((action: MenuWidgetAction) => {
    void dispatch({ kind: "widget", id, action });
  }, [dispatch, id]);
  const onSwitch = useCallback((path: string, newTab: boolean) => ask({ kind: "switch_space", path, new_tab: newTab }), [ask]);
  const onReveal = useCallback((path: string) => ask({ kind: "reveal_space", path }), [ask]);
  const onRequestForget = useCallback((path: string) => ask({ kind: "forget_space", path }), [ask]);
  const onRevealCurrent = useCallback(() => ask({ kind: "reveal_current_space" }), [ask]);
  const onAddSpace = useCallback(() => ask({ kind: "add_space" }), [ask]);
  return (
    <SpaceList
      spaces={widget.spaces}
      unavailable={widget.unavailable}
      tabs={widget.tabs}
      open={open}
      onSwitch={onSwitch}
      onReveal={onReveal}
      onRequestForget={onRequestForget}
      onRevealCurrent={onRevealCurrent}
      onAddSpace={onAddSpace}
    />
  );
}

function WidgetView({
  id,
  widget,
  dispatch,
  open,
  onRequestClose,
}: {
  id: string;
  widget: MenuWidget;
  dispatch: MenuDispatch;
  /** The menu is open. */
  open: boolean;
  /** Escape with no query closes what holds the widget: its submenu. A
   *  widget that is the whole menu has none, and Escape closes the menu. */
  onRequestClose?: () => void;
}) {
  switch (widget.kind) {
    case "collection_picker":
      return <CollectionPickerView id={id} widget={widget} dispatch={dispatch} onRequestClose={onRequestClose} />;
    case "batch_collection_picker":
      return <BatchCollectionPickerView id={id} widget={widget} dispatch={dispatch} onRequestClose={onRequestClose} />;
    case "new_card_picker":
      return <NewCardPickerView id={id} widget={widget} dispatch={dispatch} />;
    case "space_list":
      return <SpaceListView id={id} widget={widget} dispatch={dispatch} open={open} />;
  }
}

export interface MenuSpecViewProps {
  spec: MenuSpec;
  dispatch: MenuDispatch;
  /** The menu is open: a menu that closed starts again with its submenus
   *  shut. */
  open: boolean;
  /** The submenus' distance from the edges, the wrappers' own unless given. */
  collisionPadding?: number;
  /** Heard before any row of the menu or of a submenu hears a key. */
  onKeyDownCapture?: (event: ReactKeyboardEvent) => void;
}

/**
 * The entries of `spec`, to stand inside a dropdown's surface
 * (`DropdownMenuContent`).
 */
export function MenuSpecView({ spec, dispatch, open, collisionPadding, onKeyDownCapture }: MenuSpecViewProps) {
  // One submenu at a time, by its entry's id.
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  // A caption names the choice or the switches right under it.
  const captionBase = useId();
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

  /** The id of the caption at `index` of a level. */
  const captionId = (submenu: string | null, index: number) => `${captionBase}-${submenu ?? "menu"}-${index}`;

  /** The caption a choice or a run of switches at `index` stands under. */
  const captionOver = (entries: readonly MenuEntry[], index: number, submenu: string | null): string | undefined =>
    entries[index - 1]?.kind === "caption" ? captionId(submenu, index - 1) : undefined;

  const checkboxOf = (entry: Extract<MenuEntry, { kind: "checkbox" }>): ReactNode => (
    <DropdownMenuCheckboxItem
      key={entry.id}
      checked={entry.checked}
      onCheckedChange={(checked) => {
        void dispatch({ kind: "check", id: entry.id, checked });
      }}
      // The switch applies at once and the menu stays: the next one is a
      // press away.
      onSelect={(event) => event.preventDefault()}
    >
      {entry.label}
    </DropdownMenuCheckboxItem>
  );

  const entryOf = (entry: MenuEntry, index: number, submenu: string | null, entries: readonly MenuEntry[]): ReactNode => {
    switch (entry.kind) {
      case "separator":
        return <DropdownMenuSeparator key={`separator-${index}`} />;
      case "caption":
        return (
          <div
            key={`caption-${index}`}
            id={captionId(submenu, index)}
            className="px-plate py-1.5 font-mono text-sm text-muted-foreground"
            data-menu-caption=""
          >
            {entry.text}
          </div>
        );
      case "radio":
        return (
          <DropdownMenuRadioGroup
            key={entry.id}
            aria-labelledby={captionOver(entries, index, submenu)}
            value={entry.value}
            onValueChange={(value) => {
              void dispatch({ kind: "choose", id: entry.id, value });
            }}
          >
            {entry.options.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                onSelect={(event) => {
                  // A panel of settings stays open, the next choice a press
                  // away; a menu that is there for the one choice closes.
                  if (!entry.closes) event.preventDefault();
                }}
              >
                <span className="min-w-0 truncate">{option.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        );
      case "checkbox": {
        // Switches that stand together are one group: the first of a run
        // draws them all.
        if (entries[index - 1]?.kind === "checkbox") return null;
        const run: Extract<MenuEntry, { kind: "checkbox" }>[] = [];
        for (const next of entries.slice(index)) {
          if (next.kind !== "checkbox") break;
          run.push(next);
        }
        return (
          <DropdownMenuGroup key={entry.id} aria-labelledby={captionOver(entries, index, submenu)}>
            {run.map(checkboxOf)}
          </DropdownMenuGroup>
        );
      }
      case "note":
        return (
          <div key={`note-${index}`} className="px-plate py-1.5 text-sm text-destructive" data-menu-note={entry.tone}>
            {entry.text}
          </div>
        );
      case "item":
        return (
          <DropdownMenuItem
            key={entry.id}
            variant={entry.variant}
            disabled={entry.disabled}
            staysOpen={entry.stays_open}
            onSelect={(event) => {
              // What comes of it shows in the menu: the menu stays.
              if (entry.stays_open) event.preventDefault();
              run(entry.id);
            }}
          >
            {!entry.plain && <IconSlot icon={entry.icon} />}
            {entry.detail !== null ? (
              <span className="flex flex-col">
                <span>{entry.label}</span>
                <span className="text-base text-muted-foreground" data-menu-detail="">{entry.detail}</span>
              </span>
            ) : entry.truncate ? <span className="min-w-0 truncate">{entry.label}</span> : entry.label}
          </DropdownMenuItem>
        );
      case "widget":
        return (
          <WidgetView
            key={entry.id}
            id={entry.id}
            widget={entry.widget}
            dispatch={dispatch}
            open={open}
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
          <DropdownMenuSub
            key={entry.id}
            open={openSubmenu === entry.id}
            onOpenChange={(next) => setOpenSubmenu((current) => (next ? entry.id : current === entry.id ? null : current))}
          >
            <DropdownMenuSubTrigger ref={(node) => setTrigger(entry.id, node)}>
              {!entry.plain && <IconSlot icon={entry.icon} />}
              {entry.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              widthRole={entry.content.role}
              className={menuSurfaceClass(entry.content.role)}
              collisionPadding={collisionPadding}
              onKeyDownCapture={onKeyDownCapture}
            >
              {entry.content.entries.map((inner, innerIndex) => entryOf(inner, innerIndex, entry.id, entry.content.entries))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
    }
  };

  return spec.entries.map((entry, index) => entryOf(entry, index, null, spec.entries));
}
