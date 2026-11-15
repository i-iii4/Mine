// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): what the
// tab a card menu opened in and the menu panel say to each other.
//
// The backend opens and closes the menu: the tab asks it to open
// (`menu_panel_open`), it sends the panel what to draw and where the anchor
// stands on the screen (`menu-panel-open`); the panel lays the menu out and
// asks to be shown there (`menu_panel_show`); the tab hears `menu-panel-shown`,
// then `menu-panel-closed` with the reason, whoever closed it. Between the
// two the tab and the panel talk directly: the panel sends each choice to the
// tab (`menu-panel-action`), the tab runs it with its own handlers and
// answers (`menu-panel-answer`), and sends what changed in the menu
// (`menu-panel-update`). Every message names the menu's number: a late one
// for an earlier menu is dropped.

import type { TagCount } from "@/types";
import type { CardMenuEntry, CardMenuItemId, CardMenuTableCommand } from "./cardMenuEntries";

export const MENU_PANEL_LABEL = "menu-panel";

export const MENU_PANEL_OPEN_EVENT = "menu-panel-open";
export const MENU_PANEL_SHOWN_EVENT = "menu-panel-shown";
export const MENU_PANEL_CLOSED_EVENT = "menu-panel-closed";
export const MENU_PANEL_STATUS_EVENT = "menu-panel-status";
export const MENU_PANEL_UPDATE_EVENT = "menu-panel-update";
export const MENU_PANEL_ACTION_EVENT = "menu-panel-action";
export const MENU_PANEL_ANSWER_EVENT = "menu-panel-answer";

/** What opened the menu, as the panel needs it: the anchor itself comes
 *  from the backend in screen points. */
export type CardMenuOpenerKind = { kind: "plate"; align: "start" | "end" } | { kind: "point" };

/** Connect's picker in the panel: the card's collections and every one. */
export interface CardMenuPicker {
  blockSlug: string;
  selectedTags: string[];
  tags: TagCount[];
  currentTag: string | null;
}

/** What the panel draws. */
export interface CardMenuPayload {
  opener: CardMenuOpenerKind;
  /** A key opened the menu: it lands at once (SPEC_MOTION_LEVELS.md, УД4). */
  byKey: boolean;
  /** The source window's dev button style (src/lib/buttonStyle.ts). */
  buttons: string | null;
  entries: CardMenuEntry[];
  picker: CardMenuPicker;
}

/** A choice made in the panel, for the tab to carry out. */
export type MenuPanelAction =
  | { kind: "run"; id: CardMenuItemId }
  | { kind: "table"; id: string }
  | { kind: "toggle"; tag: string; hasTag: boolean }
  | { kind: "create"; tag: string }
  | { kind: "check"; name: string };

/** The tab's answer to a choice. */
export type MenuPanelAnswer =
  | { kind: "done" }
  /** A membership change was made (true), refused (false) or not known. */
  | { kind: "membership"; made: boolean | null }
  /** Why a typed collection name would be refused, or null. */
  | { kind: "refusal"; reason: string | null };

export interface MenuPanelActionMessage {
  menu: number;
  request: number;
  action: MenuPanelAction;
}

export interface MenuPanelAnswerMessage {
  menu: number;
  request: number;
  answer: MenuPanelAnswer;
}

export interface MenuPanelUpdateMessage {
  menu: number;
  payload: CardMenuPayload;
}

const ITEM_IDS: readonly CardMenuItemId[] = ["source", "copy-link", "reveal", "copy-path", "rename", "disconnect", "delete"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isItemId(value: unknown): value is CardMenuItemId {
  return ITEM_IDS.some((id) => id === value);
}

function parseEntry(value: unknown): CardMenuEntry | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "connect":
      return { kind: "connect" };
    case "separator":
      return isString(value.key) ? { kind: "separator", key: value.key } : null;
    case "table": {
      if (!Array.isArray(value.commands)) return null;
      const commands: CardMenuTableCommand[] = [];
      for (const command of value.commands) {
        if (!isRecord(command) || !isString(command.id) || !isString(command.label)
          || typeof command.destructive !== "boolean" || typeof command.separatorBefore !== "boolean") return null;
        commands.push({ id: command.id, label: command.label, destructive: command.destructive, separatorBefore: command.separatorBefore });
      }
      return { kind: "table", commands };
    }
    case "item": {
      const icon = value.icon;
      const variant = value.variant;
      if (!isItemId(value.id) || !isString(value.label) || typeof value.truncate !== "boolean") return null;
      if (icon !== null && icon !== "external" && icon !== "unlink" && icon !== "trash") return null;
      if (variant !== "default" && variant !== "detach" && variant !== "destructive") return null;
      return { kind: "item", id: value.id, label: value.label, icon, variant, truncate: value.truncate };
    }
    default:
      return null;
  }
}

function parseOpener(value: unknown): CardMenuOpenerKind | null {
  if (!isRecord(value)) return null;
  if (value.kind === "point") return { kind: "point" };
  if (value.kind === "plate" && (value.align === "start" || value.align === "end")) return { kind: "plate", align: value.align };
  return null;
}

function parseTags(value: unknown): TagCount[] | null {
  if (!Array.isArray(value)) return null;
  const tags: TagCount[] = [];
  for (const tag of value) {
    if (!isRecord(tag) || !isString(tag.tag) || typeof tag.count !== "number") return null;
    tags.push({ tag: tag.tag, count: tag.count });
  }
  return tags;
}

/** The payload a tab sent, or null when it is not one: the panel then draws
 *  nothing and closes, and the tab opens its menu on the page. */
export function parseCardMenuPayload(value: unknown): CardMenuPayload | null {
  if (!isRecord(value)) return null;
  const opener = parseOpener(value.opener);
  const picker = value.picker;
  if (opener === null || typeof value.byKey !== "boolean" || !Array.isArray(value.entries) || !isRecord(picker)) return null;
  if (value.buttons !== null && !isString(value.buttons)) return null;
  const entries: CardMenuEntry[] = [];
  for (const raw of value.entries) {
    const entry = parseEntry(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  const tags = parseTags(picker.tags);
  if (!isString(picker.blockSlug) || !isStringArray(picker.selectedTags) || tags === null) return null;
  if (picker.currentTag !== null && !isString(picker.currentTag)) return null;
  return {
    opener,
    byKey: value.byKey,
    buttons: value.buttons,
    entries,
    picker: { blockSlug: picker.blockSlug, selectedTags: picker.selectedTags, tags, currentTag: picker.currentTag },
  };
}

/** The payload as it travels through the backend: JSON text it passes on
 *  without reading. */
export function encodeCardMenuPayload(payload: CardMenuPayload): string {
  return JSON.stringify(payload);
}

export function decodeCardMenuPayload(text: string): CardMenuPayload | null {
  try {
    return parseCardMenuPayload(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseAction(value: unknown): MenuPanelAction | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "run":
      return isItemId(value.id) ? { kind: "run", id: value.id } : null;
    case "table":
      return isString(value.id) ? { kind: "table", id: value.id } : null;
    case "toggle":
      return isString(value.tag) && typeof value.hasTag === "boolean" ? { kind: "toggle", tag: value.tag, hasTag: value.hasTag } : null;
    case "create":
      return isString(value.tag) ? { kind: "create", tag: value.tag } : null;
    case "check":
      return isString(value.name) ? { kind: "check", name: value.name } : null;
    default:
      return null;
  }
}

export function parseActionMessage(value: unknown): MenuPanelActionMessage | null {
  if (!isRecord(value) || typeof value.menu !== "number" || typeof value.request !== "number") return null;
  const action = parseAction(value.action);
  return action === null ? null : { menu: value.menu, request: value.request, action };
}

export function parseAnswerMessage(value: unknown): MenuPanelAnswerMessage | null {
  if (!isRecord(value) || typeof value.menu !== "number" || typeof value.request !== "number" || !isRecord(value.answer)) return null;
  const answer = value.answer;
  switch (answer.kind) {
    case "done":
      return { menu: value.menu, request: value.request, answer: { kind: "done" } };
    case "membership":
      return answer.made === null || typeof answer.made === "boolean"
        ? { menu: value.menu, request: value.request, answer: { kind: "membership", made: answer.made } }
        : null;
    case "refusal":
      return answer.reason === null || isString(answer.reason)
        ? { menu: value.menu, request: value.request, answer: { kind: "refusal", reason: answer.reason } }
        : null;
    default:
      return null;
  }
}

export function parseUpdateMessage(value: unknown): MenuPanelUpdateMessage | null {
  if (!isRecord(value) || typeof value.menu !== "number") return null;
  const payload = parseCardMenuPayload(value.payload);
  return payload === null ? null : { menu: value.menu, payload };
}
