import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PopupApp } from "./PopupApp";
import { FolderSetupPage } from "./components/FolderSetupPage";
import "./popup-layout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("mode") === "setup" ? <FolderSetupPage /> : <PopupApp />}
  </StrictMode>,
);
