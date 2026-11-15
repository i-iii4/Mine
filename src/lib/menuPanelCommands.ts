// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the
// backend's commands of the menu panel (src-tauri/src/commands/menu_panel.rs).

import { invoke } from "@tauri-apps/api/core";
import type {
  MenuPanelCloseReason,
  MenuPanelOpenRequest,
  MenuPanelPaint,
  MenuPanelSize,
  MenuPanelStatus,
  MenuPanelTicket,
  ScreenPoint,
} from "@/types";

/** Make the panel unless it exists; whether its page is ready. */
export function prepareMenuPanelWindow(size: MenuPanelSize): Promise<MenuPanelStatus> {
  return invoke<MenuPanelStatus>("menu_panel_prepare", { size });
}

/** The panel's page is listening. */
export function reportMenuPanelReady(): Promise<void> {
  return invoke<void>("menu_panel_ready");
}

/** Open a menu of this tab in the panel; a refusal rejects. */
export function openInMenuPanel(request: MenuPanelOpenRequest): Promise<MenuPanelTicket> {
  return invoke<MenuPanelTicket>("menu_panel_open", { request });
}

/** The panel's page laid the menu out: show the panel at `origin`. */
export function showMenuPanel(menu: number, origin: ScreenPoint): Promise<void> {
  return invoke<void>("menu_panel_show", { menu, origin });
}

/** Close the menu `menu`; one already closed is left. */
export function closeMenuPanel(menu: number, reason: MenuPanelCloseReason): Promise<void> {
  return invoke<void>("menu_panel_close", { menu, reason });
}

/** The panel drew its first frame of the menu: the backend logs the time
 *  from the input and the look of the window under it. */
export function reportMenuPanelPainted(paint: MenuPanelPaint): Promise<void> {
  return invoke<void>("menu_panel_painted", { paint });
}
