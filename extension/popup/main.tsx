import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PopupApp } from "./PopupApp";
import { FolderSetupPage } from "./components/FolderSetupPage";
import "./popup-layout.css";
import { followSystemMotion } from "@/lib/motion";

// The clipper follows the system's "Reduce motion" alone, never the app's
// Motion setting (SPEC_MOTION_LEVELS.md, УД10, НС7).
followSystemMotion(document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("mode") === "setup" ? <FolderSetupPage /> : <PopupApp />}
  </StrictMode>,
);
