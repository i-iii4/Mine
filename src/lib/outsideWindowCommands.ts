// The backend's commands and events of the outside window
// (SPEC_OUTSIDE_WINDOW.md, part В; src-tauri/src/commands/outside_window.rs).
// The shapes of every message are the backend's (src/types/generated.ts).

import { invoke } from "@tauri-apps/api/core";
import type {
  OutsidePageReport,
  OutsideWindowStatus,
  PreviewOpenRequest,
  PreviewStepRequest,
} from "@/types";

export const OUTSIDE_WINDOW_LABEL = "outside-window";
/** What the backend tells the outside window's page (`OutsidePageMessage`). */
export const OUTSIDE_TO_PAGE_EVENT = "outside-window-message";
/** What the backend tells a source page (`OutsideSourceMessage`). */
export const OUTSIDE_TO_SOURCE_EVENT = "outside-window-report";

/** Make the outside window unless it exists; whether it is ready. `page` is
 *  this page's load: a showing its former load left open closes. */
export function prepareOutsideWindow(page: string): Promise<OutsideWindowStatus> {
  return invoke<OutsideWindowStatus>("outside_window_prepare", { page });
}

/** Open a showing of this page's preview outside its app window; a refusal
 *  rejects with its reason (`OutsideRefusal`), and the preview stays inside. */
export function openPreviewOutside(request: PreviewOpenRequest): Promise<void> {
  return invoke<void>("outside_window_open_preview", { request });
}

/** A numbered step of this page's showing. */
export function sendPreviewStep(request: PreviewStepRequest): Promise<void> {
  return invoke<void>("outside_window_preview_step", { request });
}

/** The outside window's page reports. */
export function reportOutsideWindow(report: OutsidePageReport): Promise<void> {
  return invoke<void>("outside_window_report", { report });
}
