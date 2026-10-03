import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EdgeStatesSection } from "@/components/EdgeStatesSection";
import "./styles/global.css";

// The bench runs in a plain browser, outside Tauri: media paths go through
// unchanged, as on the other audit routes (src/main.tsx). The cast names the
// one field Tauri would have put on the window.
type BenchWindow = Window & {
  __TAURI_INTERNALS__?: { convertFileSrc?: (filePath: string, protocol?: string) => string };
};
const benchWindow = window as BenchWindow;
benchWindow.__TAURI_INTERNALS__ = benchWindow.__TAURI_INTERNALS__ ?? {};
benchWindow.__TAURI_INTERNALS__.convertFileSrc ??= (filePath) => filePath;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-full bg-background p-8 text-foreground">
      <EdgeStatesSection />
    </div>
  </StrictMode>,
);
