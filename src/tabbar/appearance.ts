// The bar's look follows the app's settings: applied before the first render,
// as the settings window does (src/settings/main.tsx), and again whenever the
// settings window changes one (src/lib/settingsChanged.ts). The bar shows no
// cards, so only the settings that reach the chrome matter here.

import { useEffect } from "react";
import { applyDesign, DESIGN_STORAGE_KEY, getStoredDesignMode } from "@/lib/designMode";
import {
  applyInterfaceFont,
  getStoredInterfaceFont,
  INTERFACE_FONT_STORAGE_KEY,
} from "@/lib/fontChoice";
import {
  adoptSettingsChange,
  SETTINGS_CHANGED_EVENT,
  type SettingsChangedPayload,
} from "@/lib/settingsChanged";
import { applyTheme, getStoredTheme, THEME_STORAGE_KEY } from "@/lib/themeMode";
import { listenHere } from "./useTabBarState";

/** Apply the stored theme, layout variant and interface font to this page. */
export function applyStoredAppearance(): void {
  applyTheme(getStoredTheme());
  applyDesign(getStoredDesignMode());
  applyInterfaceFont(getStoredInterfaceFont());
}

/** Re-apply what a settings change touches. The event is global; a page's
 *  own subscription receives it too. */
export function useAppearanceSync(): void {
  useEffect(
    () =>
      listenHere<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (payload) => {
        adoptSettingsChange(payload);
        if (payload.key === THEME_STORAGE_KEY) applyTheme(getStoredTheme());
        else if (payload.key === DESIGN_STORAGE_KEY) applyDesign(getStoredDesignMode());
        else if (payload.key === INTERFACE_FONT_STORAGE_KEY) applyInterfaceFont(getStoredInterfaceFont());
      }),
    [],
  );
}
