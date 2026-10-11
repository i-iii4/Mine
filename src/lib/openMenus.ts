import { useCallback, useEffect, useLayoutEffect, useRef, type Ref } from "react";

// Every menu and context menu is non-modal (DESIGN_SYSTEM.md, «Всплывающие
// элементы», «Открытое меню»). A modal Radix menu sets `pointer-events: none`
// on the body while it is open, so nothing under it answers the pointer:
// cards did not lift, rows and buttons did not light until the menu closed.
// What the modal menu did besides is kept here, once for every menu:
//
// - a press outside an open menu only closes it: neither the press nor the
//   click it makes reach what lies under the pointer, as a macOS menu takes
//   the click that dismisses it. The rest of the press that opens a menu ends
//   the same way, so a trigger inside a clickable row does not act on the row;
// - the wheel outside an open menu scrolls nothing;
// - after such a press the focus comes back where the modal menu sent it.
//
// The pointer's hover passes untouched.

type MenuKind = "dropdown" | "context";

type PointerDownOutsideEvent = CustomEvent<{ originalEvent: PointerEvent }>;

/** Radix marks every menu and submenu surface with this attribute. */
const MENU_SURFACE = "data-radix-menu-content";

/** Set on the root element while a menu surface is on the page. */
const MENU_OPEN_ATTRIBUTE = "data-menu-open";

/** The rest of a press after its `pointerdown`. */
const PRESS_EVENTS = ["mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu"] as const;

/** The root surfaces of the menus on the page, open or closing. */
const menuSurfaces = new Set<HTMLElement>();

/** The presses this module dispatches to close the open menus. */
const dismissPresses = new WeakSet<Event>();

interface Press {
  /** It began outside an open menu and closed it. */
  consumed: boolean;
  /** A menu was open when it began. */
  menuWasOpen: boolean;
}

let press: Press | null = null;
let pressEndTimer: ReturnType<typeof setTimeout> | null = null;
let guardHolders = 0;

function openMenuSurface(): HTMLElement | null {
  for (const surface of menuSurfaces) {
    if (surface.isConnected && surface.getAttribute("data-state") === "open") return surface;
  }
  return null;
}

/** The event's path crosses a menu or a submenu, shadow roots included. */
function isOnMenu(event: Event): boolean {
  return event.composedPath().some(
    (target) => target instanceof Element && target.hasAttribute(MENU_SURFACE),
  );
}

function hold(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Closes the open menus the way Radix closes them for a press outside. The
 * press a modal menu let through landed on the root element, where no control
 * acts on it; a copy of the held press goes there. It carries no pointer type:
 * Radix closes on a touch only at its click, and this module holds that click.
 */
function dismissOpenMenus(surface: HTMLElement, event: PointerEvent): void {
  const doc = surface.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return;
  const dismiss = new view.PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: event.button,
    buttons: event.buttons,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    pointerId: event.pointerId,
    isPrimary: event.isPrimary,
  });
  dismissPresses.add(dismiss);
  doc.documentElement.dispatchEvent(dismiss);
}

function handlePointerDown(event: PointerEvent): void {
  if (dismissPresses.has(event)) return;
  if (pressEndTimer !== null) {
    clearTimeout(pressEndTimer);
    pressEndTimer = null;
  }
  const surface = openMenuSurface();
  const outside = surface !== null && !isOnMenu(event);
  press = { consumed: outside, menuWasOpen: surface !== null };
  if (surface === null || !outside) return;
  hold(event);
  dismissOpenMenus(surface, event);
}

function handlePressEvent(event: Event): void {
  if (press === null || isOnMenu(event)) return;
  const openedMenu = !press.menuWasOpen && openMenuSurface() !== null;
  if (press.consumed || openedMenu) hold(event);
}

function handlePressEnd(event: Event): void {
  handlePressEvent(event);
  // The click and the double click follow the release within the same task.
  if (pressEndTimer !== null) clearTimeout(pressEndTimer);
  pressEndTimer = setTimeout(() => {
    press = null;
    pressEndTimer = null;
  }, 0);
}

function handleWheel(event: WheelEvent): void {
  if (openMenuSurface() !== null && !isOnMenu(event)) hold(event);
}

function installGuard(): void {
  window.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("pointerup", handlePressEnd, true);
  window.addEventListener("pointercancel", handlePressEnd, true);
  for (const type of PRESS_EVENTS) window.addEventListener(type, handlePressEvent, true);
  window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
}

function removeGuard(): void {
  window.removeEventListener("pointerdown", handlePointerDown, true);
  window.removeEventListener("pointerup", handlePressEnd, true);
  window.removeEventListener("pointercancel", handlePressEnd, true);
  for (const type of PRESS_EVENTS) window.removeEventListener(type, handlePressEvent, true);
  window.removeEventListener("wheel", handleWheel, true);
  if (pressEndTimer !== null) clearTimeout(pressEndTimer);
  pressEndTimer = null;
  press = null;
}

/**
 * The guard listens while any menu surface is mounted, closed ones included:
 * it must see the press that opens a menu to hold the rest of that press.
 */
function holdGuard(): () => void {
  guardHolders += 1;
  if (guardHolders === 1) installGuard();
  return () => {
    guardHolders -= 1;
    if (guardHolders === 0) removeGuard();
  };
}

/** A press outside that closed the open menus; a dialog under them keeps open. */
export function isMenuDismissPress(event: Event): boolean {
  return dismissPresses.has(event);
}

/** A primary press; Control with it is the macOS right click. */
function isPrimaryPress(event: PointerEvent): boolean {
  return event.button === 0 && !event.ctrlKey;
}

function focusedElement(node: HTMLElement): HTMLElement | null {
  const root = node.getRootNode();
  const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
  return active instanceof HTMLElement && active !== node.ownerDocument.body ? active : null;
}

/** The button that opened a dropdown menu: Radix labels the menu by it. */
export function menuTriggerOf(surface: HTMLElement): HTMLElement | null {
  const id = surface.getAttribute("aria-labelledby");
  const root = surface.getRootNode();
  if (!id || !(root instanceof Document || root instanceof ShadowRoot)) return null;
  const trigger = root.getElementById(id);
  return trigger instanceof HTMLElement ? trigger : null;
}

function markMenuOpen(doc: Document): void {
  doc.documentElement.toggleAttribute(MENU_OPEN_ATTRIBUTE, menuSurfaces.size > 0);
}

interface MenuSurfaceHandlers {
  onPointerDownOutside?: (event: PointerDownOutsideEvent) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Wires one root menu surface (`DropdownMenuContent`, `ContextMenuContent`)
 * into the guard: its ref, merged with the caller's, and the two handlers,
 * composed with the caller's. After the press that closed the menu the focus
 * goes where the modal menu sent it: a dropdown's to its trigger after a
 * primary press, a context menu's to what held the focus before it opened.
 */
export function useMenuSurface<T extends HTMLElement>(
  kind: MenuKind,
  ref: Ref<T> | undefined,
  { onPointerDownOutside, onCloseAutoFocus }: MenuSurfaceHandlers,
) {
  const surfaceRef = useRef<T | null>(null);
  const focusBeforeRef = useRef<HTMLElement | null>(null);
  const focusAfterPressRef = useRef<HTMLElement | null>(null);

  useEffect(() => holdGuard(), []);

  const setSurface = useCallback(
    (node: T | null) => {
      const previous = surfaceRef.current;
      if (node !== previous) {
        if (previous) menuSurfaces.delete(previous);
        if (node) {
          menuSurfaces.add(node);
          // Attached before Radix moves the focus into the menu.
          focusBeforeRef.current = focusedElement(node);
        }
        surfaceRef.current = node;
        const doc = (node ?? previous)?.ownerDocument;
        if (doc) markMenuOpen(doc);
      }
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const handlePointerDownOutside = useCallback(
    (event: PointerDownOutsideEvent) => {
      onPointerDownOutside?.(event);
      const original = event.detail.originalEvent;
      if (event.defaultPrevented || !dismissPresses.has(original)) return;
      const surface = surfaceRef.current;
      focusAfterPressRef.current =
        kind === "context"
          ? focusBeforeRef.current
          : surface && isPrimaryPress(original) ? menuTriggerOf(surface) : null;
    },
    [kind, onPointerDownOutside],
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event);
      const target = focusAfterPressRef.current;
      focusAfterPressRef.current = null;
      if (event.defaultPrevented || !target?.isConnected) return;
      target.focus();
    },
    [onCloseAutoFocus],
  );

  return {
    ref: setSurface,
    onPointerDownOutside: handlePointerDownOutside,
    onCloseAutoFocus: handleCloseAutoFocus,
  };
}

const openContextMenus = new Set<object>();
const contextMenuListeners = new Set<(open: boolean) => void>();

function setContextMenuOpen(presence: object, open: boolean): void {
  const wasOpen = openContextMenus.size > 0;
  if (open) openContextMenus.add(presence);
  else openContextMenus.delete(presence);
  const isOpen = openContextMenus.size > 0;
  if (isOpen !== wasOpen) for (const listener of contextMenuListeners) listener(isOpen);
}

/**
 * Reports a context menu, a menu a right click opened, for as long as it is
 * open. While one is, the pointer's answers hold (SPEC_CARD_STATES.md, С7.8).
 */
export function useContextMenuPresence(open: boolean): void {
  useLayoutEffect(() => {
    if (!open) return;
    const presence = {};
    setContextMenuOpen(presence, true);
    return () => setContextMenuOpen(presence, false);
  }, [open]);
}

/** Calls `listener` whenever the first context menu opens or the last one closes. */
export function subscribeContextMenus(listener: (open: boolean) => void): () => void {
  contextMenuListeners.add(listener);
  if (openContextMenus.size > 0) listener(true);
  return () => {
    contextMenuListeners.delete(listener);
  };
}
