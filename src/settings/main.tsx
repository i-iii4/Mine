import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";
import { applyCardRadius, getStoredCardRadius } from "@/lib/cardRadius";
import { applyDensity, getStoredDensity } from "@/lib/density";
import {
  applyContentFont,
  applyInterfaceFont,
  getStoredContentFont,
  getStoredInterfaceFont,
} from "@/lib/fontChoice";
import { SettingsApp } from "./SettingsApp";
import "@/styles/global.css";
import { hydrateCommandOverrides, watchCommandOverrides } from "@/lib/shortcutOverrides";
import { answerSwipeQuestion } from "@/lib/horizontalScroller";

// The settings window applies the stored theme itself — it cannot rely on the
// main window having done so for this webview.
applyTheme(getStoredTheme());
applyCardRadius(getStoredCardRadius());
applyDensity(getStoredDensity());
applyInterfaceFont(getStoredInterfaceFont());
applyContentFont(getStoredContentFont());

// The two-finger swipe asks the page what stands under the pointer
// (SPEC_NARROW_WINDOW.md, У17).
answerSwipeQuestion();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found. Check settings.html for div#root.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <SettingsApp />
    </TooltipProvider>
  </React.StrictMode>,
);

void hydrateCommandOverrides();
watchCommandOverrides();
