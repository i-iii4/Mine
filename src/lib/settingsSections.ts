/** Shared navigation for the main-window menu and the settings window. */
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "graph", label: "Graph" },
  { id: "spaces", label: "Spaces" },
  { id: "layout", label: "New files" },
  { id: "clipper", label: "Extension" },
  { id: "updates", label: "Updates" },
  { id: "orphans", label: "Orphans" },
  { id: "design-system", label: "Design system" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some(({ id }) => id === value);
}
