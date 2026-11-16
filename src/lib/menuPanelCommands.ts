// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): the backend's commands of the menu panel
// (src-tauri/src/commands/menu_panel.rs).

import { invoke } from "@tauri-apps/api/core";
import type {
  MenuAnswer,
  MenuPanelCloseOutcome,
  MenuPanelCloseReason,
  MenuPanelOpenRequest,
  MenuPanelPageRequest,
  MenuPanelPaint,
  MenuPanelStatus,
  MenuSpec,
} from "@/types";

/** Make the panel unless it exists; whether it is ready: its page listens
 *  and its window was found clear. `page` is this page's load: a menu its
 *  former load left open closes. */
export function prepareMenuPanelWindow(page: string): Promise<MenuPanelStatus> {
  return invoke<MenuPanelStatus>("menu_panel_prepare", { page });
}

/** The Web mode: take the panel away. */
export function disposeMenuPanelWindow(): Promise<void> {
  return invoke<void>("menu_panel_dispose");
}

/** The panel's page listens and has drawn its rest: the backend checks the
 *  panel for clearness. */
export function reportMenuPanelReady(): Promise<void> {
  return invoke<void>("menu_panel_ready");
}

/** Open a menu of this page in the panel, shown at once; a refusal rejects. */
export function openInMenuPanel(request: MenuPanelOpenRequest): Promise<void> {
  return invoke<void>("menu_panel_open", { request });
}

/** What changed in this page's open menu `menu`: the whole menu again, the
 *  page's change number `number`. */
export function updateMenuInPanel(menu: number, number: number, spec: MenuSpec): Promise<void> {
  return invoke<void>("menu_panel_update", { menu, number, spec });
}

/** This page's answer to the panel's request `request` of its menu `menu`. */
export function answerMenuPanel(menu: number, request: number, answer: MenuAnswer): Promise<void> {
  return invoke<void>("menu_panel_answer", { menu, request, answer });
}

/** Close this tab's menu `menu`; what the closing came to. One already
 *  closed is left, and one not opened yet will not open. */
export function closeMenuPanel(page: string, menu: number, reason: MenuPanelCloseReason): Promise<MenuPanelCloseOutcome> {
  return invoke<MenuPanelCloseOutcome>("menu_panel_close", { page, menu, reason });
}

/** The panel's page asks for a choice to be carried out, for its menu to
 *  close, or both, the choice first. */
export function requestOfMenuPanel(request: MenuPanelPageRequest): Promise<void> {
  return invoke<void>("menu_panel_request", { request });
}

/** The panel drew its first frame of the menu: the backend logs each step's
 *  time from the input and the look of the window under it. */
export function reportMenuPanelPainted(paint: MenuPanelPaint): Promise<void> {
  return invoke<void>("menu_panel_painted", { paint });
}
