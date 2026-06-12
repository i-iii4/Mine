import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";
import { SettingsApp } from "./SettingsApp";
import "@/styles/global.css";

// The settings window applies the stored theme itself — it cannot rely on the
// main window having done so for this webview.
applyTheme(getStoredTheme());

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
