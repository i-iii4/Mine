// The menu panel draws in the app's look: the stored theme, motion level,
// fonts, card radius and spacing, applied before the first render and again
// whenever the settings window changes one (src/lib/settingsChanged.ts).

import { applyCardRadius, getStoredCardRadius } from "@/lib/cardRadius";
import { applyDensity, getStoredDensity } from "@/lib/density";
import { applyContentFont, applyInterfaceFont, getStoredContentFont, getStoredInterfaceFont } from "@/lib/fontChoice";
import { installMotionLevel, reloadMotionLevel } from "@/lib/motion";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";

let installed = false;

export function applyMenuPanelAppearance(): void {
  applyTheme(getStoredTheme());
  // The motion level before the first frame (SPEC_MOTION_LEVELS.md, НС5).
  if (installed) reloadMotionLevel();
  else installMotionLevel();
  installed = true;
  applyCardRadius(getStoredCardRadius());
  applyDensity(getStoredDensity());
  applyInterfaceFont(getStoredInterfaceFont());
  applyContentFont(getStoredContentFont());
}

/** The source window's dev button style (src/lib/buttonStyle.ts). */
export function applyMenuPanelButtons(style: string | null): void {
  if (style === null) document.documentElement.removeAttribute("data-buttons");
  else document.documentElement.setAttribute("data-buttons", style);
}
