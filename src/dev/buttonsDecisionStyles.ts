// The two button styles of the decision page (`/__buttons-decision`): macOS,
// as the app draws it now, and the retro tile. The fill follows the colour
// rules in both styles, so both take the app's own face; only the volume
// differs, built from the fill's colour as shares of white or black over it.
// macOS lifts the button with its depth recipe; the retro tile draws a light
// 1px line along its top edge (above everything, so it starts at the edge),
// a dark 1px line along its bottom edge and a hairline outside the face, and
// casts no shadow. Dev tool, nothing here is used by the app.

export type ButtonStyle = "macos" | "retro";
export type Theme = "light" | "dark";

/** The retro tile's depth layers (`--button-depth`) for each theme: light as
 *  on 04.10.2026, dark as drawn 05.10.2026. */
export const RETRO_DEPTH: Readonly<Record<Theme, string>> = {
  light: "inset 0 1px 0 rgb(255 255 255 / 1), inset 0 -1px 0 rgb(0 0 0 / 0.05), 0 0 0 0.5px rgb(0 0 0 / 0.07)",
  dark: "inset 0 1px 0 rgb(255 255 255 / 0.12), inset 0 -1px 0 rgb(0 0 0 / 0.3), 0 0 0 0.5px rgb(0 0 0 / 0.45)",
};
