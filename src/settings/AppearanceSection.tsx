import { useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Checkbox } from "@/components/ui/checkbox";
import {
  applyTheme,
  getStoredTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "@/lib/themeMode";
import {
  COMPACT_DETAIL_TOP_MENU_STORAGE_KEY,
  getStoredCompactDetailTopMenu,
} from "@/lib/compactDetailTopMenuVisibility";
import {
  BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY,
  getStoredBottomActionBarHidden,
} from "@/lib/bottomActionBarVisibility";
import {
  SETTINGS_CHANGED_EVENT,
  type SettingsChangedPayload,
} from "@/lib/settingsChanged";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

// Broadcast a settings change to every window (the main window re-reads the
// changed key). localStorage is shared across windows of the same origin, so
// the event carries only the key, not the value.
function broadcastSettingsChange(key: string) {
  const payload: SettingsChangedPayload = { key };
  void emit(SETTINGS_CHANGED_EVENT, payload).catch((error) => {
    console.error("Failed to broadcast settings change:", error);
  });
}

interface SettingRowProps {
  label: string;
  caption?: string;
  children: React.ReactNode;
}

function SettingRow({ label, caption, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-s3">
      <div className="min-w-0">
        <p className="text-base">{label}</p>
        {caption && <p className="text-sm text-muted-foreground">{caption}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [compactDetailTopMenu, setCompactDetailTopMenu] = useState(
    getStoredCompactDetailTopMenu,
  );
  const [bottomActionBarHidden, setBottomActionBarHidden] = useState(
    getStoredBottomActionBarHidden,
  );

  const handleThemeChange = (mode: ThemeMode) => {
    setTheme(mode);
    applyTheme(mode);
    broadcastSettingsChange(THEME_STORAGE_KEY);
  };

  const handleCompactChange = (checked: boolean) => {
    setCompactDetailTopMenu(checked);
    localStorage.setItem(COMPACT_DETAIL_TOP_MENU_STORAGE_KEY, checked ? "true" : "false");
    broadcastSettingsChange(COMPACT_DETAIL_TOP_MENU_STORAGE_KEY);
  };

  const handleBottomChange = (checked: boolean) => {
    setBottomActionBarHidden(checked);
    localStorage.setItem(BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY, checked ? "true" : "false");
    broadcastSettingsChange(BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY);
  };

  return (
    <section className="flex flex-col gap-s3">
      <h1 className="text-lg font-semibold">Appearance</h1>

      <SettingRow label="Theme">
        <SegmentedControl
          aria-label="Theme"
          size="default"
          value={theme}
          options={THEME_OPTIONS}
          onChange={handleThemeChange}
        />
      </SettingRow>

      <SettingRow
        label="Compact Detail top menu"
        caption="Collapse the Detail view header into the window chrome"
      >
        <Checkbox
          aria-label="Compact Detail top menu"
          checked={compactDetailTopMenu}
          onCheckedChange={(checked) => handleCompactChange(checked === true)}
        />
      </SettingRow>

      <SettingRow
        label="Hide bottom menu"
        caption="Move the bottom action bar controls into the top chrome"
      >
        <Checkbox
          aria-label="Hide bottom menu"
          checked={bottomActionBarHidden}
          onCheckedChange={(checked) => handleBottomChange(checked === true)}
        />
      </SettingRow>
    </section>
  );
}
