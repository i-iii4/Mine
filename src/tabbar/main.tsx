import React from "react";
import ReactDOM from "react-dom/client";
import { installControlCharGuard } from "@/lib/controlCharGuard";
import { applyStoredAppearance } from "./appearance";
import { TabBarApp } from "./TabBarApp";
import "@/styles/global.css";
import "./tabbar.css";

// The bar is its own page: it applies the stored look itself before the first
// render, as the settings window does.
applyStoredAppearance();
// Arrow keys in a child page can type stray control characters (В80).
installControlCharGuard();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found. Check tabbar.html for div#root.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <TabBarApp />
  </React.StrictMode>,
);
