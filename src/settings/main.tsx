import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";
import { applyDesign, getStoredDesignMode } from "@/lib/designMode";
import { applyCardRadius, getStoredCardRadius } from "@/lib/cardRadius";
import { SettingsApp } from "./SettingsApp";
import "@/styles/global.css";

// The settings window applies the stored theme and design itself — it cannot
// rely on the main window having done so for this webview.
applyTheme(getStoredTheme());
applyDesign(getStoredDesignMode());
applyCardRadius(getStoredCardRadius());

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
