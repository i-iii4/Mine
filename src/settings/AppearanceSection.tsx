import { useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Checkbox } from "@/components/ui/checkbox";
import {
  applyTheme,
  getStoredTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "@/lib/themeMode";
import {
  BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY,
  getStoredBottomActionBarHidden,
} from "@/lib/bottomActionBarVisibility";
import {
  SCROLL_EDGE_FADE_STORAGE_KEY,
  getStoredScrollEdgeFade,
} from "@/lib/scrollEdgeFade";
import {
  DENSITY_STEPS,
  DENSITY_STORAGE_KEY,
  applyDensity,
  getStoredDensity,
  type DensityStep,
} from "@/lib/density";
import {
  CARD_RADIUS_OPTIONS,
  CARD_RADIUS_STORAGE_KEY,
  applyCardRadius,
  getStoredCardRadius,
  type CardRadius,
} from "@/lib/cardRadius";
import {
  broadcastSettingsChange,
} from "@/lib/settingsChanged";
import { SettingRow } from "./SettingRow";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

// Layout axis, orthogonal to the color theme: any theme + either design.
// SegmentedControl is keyed by strings; the radius stays numeric everywhere else.
const CARD_RADIUS_CONTROL_OPTIONS = CARD_RADIUS_OPTIONS.map((value) => ({
  value: String(value),
  label: value === 0 ? "Square" : String(value),
}));

const DENSITY_OPTIONS = DENSITY_STEPS.map((step) => ({
  value: String(step),
  label: String(step),
}));

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [bottomActionBarHidden, setBottomActionBarHidden] = useState(
    getStoredBottomActionBarHidden,
  );
  const [scrollEdgeFade, setScrollEdgeFade] = useState(getStoredScrollEdgeFade);
  const [cardRadius, setCardRadius] = useState<CardRadius>(getStoredCardRadius);
  const [density, setDensity] = useState<DensityStep>(getStoredDensity);

  const handleThemeChange = (mode: ThemeMode) => {
    setTheme(mode);
    applyTheme(mode);
    broadcastSettingsChange(THEME_STORAGE_KEY);
  };

  const handleBottomChange = (checked: boolean) => {
    setBottomActionBarHidden(checked);
    localStorage.setItem(BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY, checked ? "true" : "false");
    broadcastSettingsChange(BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY);
  };

  const handleDensityChange = (raw: string) => {
    const value = Number(raw) as DensityStep;
    setDensity(value);
    applyDensity(value);
    broadcastSettingsChange(DENSITY_STORAGE_KEY);
  };

  const handleCardRadiusChange = (raw: string) => {
    const value = Number(raw) as CardRadius;
    setCardRadius(value);
    applyCardRadius(value);
    broadcastSettingsChange(CARD_RADIUS_STORAGE_KEY);
  };

  const handleScrollEdgeFadeChange = (checked: boolean) => {
    setScrollEdgeFade(checked);
    localStorage.setItem(SCROLL_EDGE_FADE_STORAGE_KEY, checked ? "true" : "false");
    broadcastSettingsChange(SCROLL_EDGE_FADE_STORAGE_KEY);
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
        label="Spacing"
        caption="Distance from edges and chrome, and between cards: bars, sidebar, feed, expanded card"
      >
        <SegmentedControl
          aria-label="Spacing"
          size="default"
          value={String(density)}
          options={DENSITY_OPTIONS}
          onChange={handleDensityChange}
        />
      </SettingRow>

      <SettingRow
        label="Card corners"
        caption="Corner radius of cards and their images, in pixels"
      >
        <SegmentedControl
          aria-label="Card corners"
          size="default"
          value={String(cardRadius)}
          options={CARD_RADIUS_CONTROL_OPTIONS}
          onChange={handleCardRadiusChange}
        />
      </SettingRow>

      <SettingRow
        label="Fade content under the chrome"
        caption="Dissolve the top edge of the sidebar, feed, Detail and search as they scroll"
      >
        <Checkbox
          aria-label="Fade content under the chrome"
          checked={scrollEdgeFade}
          onCheckedChange={(checked) => handleScrollEdgeFadeChange(checked === true)}
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
