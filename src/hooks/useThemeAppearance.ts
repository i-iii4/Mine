// Resolved color scheme for surfaces whose visuals differ between themes.
//
// The stored preference has three values (system / light / dark), but a surface
// needs the resolved one. `data-theme` carries an explicit choice; its absence
// means "system", which is read from the media query.

import { useEffect, useState } from "react";
import type { TopFadeAppearance } from "@/lib/edgeFade";

/// Read the currently applied color scheme. Mirrors the resolution used for the
/// native window chrome so both agree on what "system" currently means.
export function resolveThemeAppearance(): TopFadeAppearance {
  if (typeof document === "undefined") return "light";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

/// Track the applied color scheme across explicit and system changes.
export function useThemeAppearance(): TopFadeAppearance {
  const [appearance, setAppearance] = useState(resolveThemeAppearance);

  useEffect(() => {
    const sync = () => setAppearance(resolveThemeAppearance());
    sync();

    // `applyTheme` sets or removes `data-theme` on the root element.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", sync);

    return () => {
      observer.disconnect();
      media?.removeEventListener("change", sync);
    };
  }, []);

  return appearance;
}
