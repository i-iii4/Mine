// The outside window's page (SPEC_OUTSIDE_WINDOW.md, НО1): clear, it draws
// only what a source page shows outside its app window. It applies the stored
// look itself, as the menu panel's page does.

import React from "react";
import ReactDOM from "react-dom/client";
import { applyMenuPanelAppearance } from "@/menuPanel/appearance";
import { OutsideWindowApp } from "./OutsideWindowApp";
import "@/styles/global.css";
import "./outsideWindow.css";

applyMenuPanelAppearance();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found. Check outside-window.html for div#root.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <OutsideWindowApp />
  </React.StrictMode>,
);
