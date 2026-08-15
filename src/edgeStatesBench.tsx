import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EdgeStatesSection } from "@/components/EdgeStatesSection";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-full bg-background p-8 text-foreground">
      <EdgeStatesSection />
    </div>
  </StrictMode>,
);
