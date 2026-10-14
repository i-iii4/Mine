// A failure the person has nothing to do about goes to Mine's log, not to
// the screen (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»): a link
// the browser would not open, Reveal in Finder, Copy Path and Copy Link, a
// command of the tab bar. The page writes through the app's logger
// (`tauri-plugin-log`), so the line lands in `Mine.log` with its time, next
// to the backend's own lines.

import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./errorMessage";

/** The logger's level for a warning (`tauri_plugin_log::LogLevel::Warn`). */
const WARN_LEVEL = 4;

/** Write `what` failed, with why, to Mine's log. A log that cannot be
 *  reached leaves the line to the console. */
export function logFailure(what: string, error: unknown): void {
  const message = `${what}: ${errorMessage(error)}`;
  void invoke("plugin:log|log", { level: WARN_LEVEL, message, location: "page" }).catch((logError: unknown) => {
    console.error(message, logError);
  });
}
