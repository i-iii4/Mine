// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the page
// of the menu panel, the window the feed card's menu is drawn in when the
// menu mode is `window`. It applies the stored look itself, as the tab bar
// and the settings window do.

import React from "react";
import ReactDOM from "react-dom/client";
import { installMotionInput } from "@/lib/motionInput";
import { installControlCharGuard } from "@/lib/controlCharGuard";
import { hydrateCommandOverrides, watchCommandOverrides } from "@/lib/shortcutOverrides";
import { applyMenuPanelAppearance } from "./appearance";
import { MenuPanelApp } from "./MenuPanelApp";
import "@/styles/global.css";
import "./menuPanel.css";

applyMenuPanelAppearance();
// What a key opened lands at once (SPEC_MOTION_LEVELS.md, УД4).
installMotionInput();
// The search field of Connect is a field of a child-less window, but the
// same guard keeps stray control characters out of it (SPEC_TABS.md, В80).
installControlCharGuard();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found. Check menu-panel.html for div#root.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <MenuPanelApp />
  </React.StrictMode>,
);

void hydrateCommandOverrides();
watchCommandOverrides();
