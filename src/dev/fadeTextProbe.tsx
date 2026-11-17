// The tab's label line alone (`FadeText` with the tab's class), for
// scripts/fade-text-audit.mjs: the audit reads in WebKit whether a glyph
// taller than the line is drawn whole (DESIGN_SYSTEM.md, «Растворение
// кромок»). Not part of the app.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FadeText } from "@/components/ui/fade-text";
import { TAB_LABEL_CLASS } from "@/tabbar/constants";
import "@/styles/global.css";

/** What the audit draws: a label that fits and one that dissolves, each with
 *  an emoji and with the letters that reach past the line. */
export const PROBE_LABELS = ["Motion Details 🔎", "gЙ 😀 a label far too long for its tab, cut and dissolved 🔎"];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {PROBE_LABELS.map((label) => (
      // As a tab lays its label out: a row as tall as the bar, the label
      // centred in it, a tab's widest.
      <div key={label} data-probe-row="" className="flex h-10 w-[200px] items-center pl-3 pr-1">
        <FadeText text={label} className={TAB_LABEL_CLASS} />
      </div>
    ))}
  </StrictMode>,
);
