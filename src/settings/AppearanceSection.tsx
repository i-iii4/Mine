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
  applyDesign,
  getStoredDesignMode,
  DESIGN_STORAGE_KEY,
  type DesignMode,
} from "@/lib/designMode";
import {
  COMPACT_DETAIL_TOP_MENU_STORAGE_KEY,
  getStoredCompactDetailTopMenu,
} from "@/lib/compactDetailTopMenuVisibility";
import {
  BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY,
  getStoredBottomActionBarHidden,
} from "@/lib/bottomActionBarVisibility";
import {
  SCROLL_EDGE_FADE_STORAGE_KEY,
  getStoredScrollEdgeFade,
} from "@/lib/scrollEdgeFade";
import {
  ACTION_BUTTON_STYLE_STORAGE_KEY,
  applyActionButtonStyle,
  getStoredActionButtonStyle,
  type ActionButtonStyle,
} from "@/lib/actionButtonStyle";
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

const ACTION_BUTTON_OPTIONS = [
  { value: "pill", label: "Pill" },
  { value: "standard", label: "Standard" },
] as const;

const DESIGN_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "alt", label: "Alt" },
] as const;

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [design, setDesign] = useState<DesignMode>(getStoredDesignMode);
  const [compactDetailTopMenu, setCompactDetailTopMenu] = useState(
    getStoredCompactDetailTopMenu,
  );
  const [bottomActionBarHidden, setBottomActionBarHidden] = useState(
    getStoredBottomActionBarHidden,
  );
  const [scrollEdgeFade, setScrollEdgeFade] = useState(getStoredScrollEdgeFade);
  const [cardRadius, setCardRadius] = useState<CardRadius>(getStoredCardRadius);
  const [actionButtonStyle, setActionButtonStyle] = useState<ActionButtonStyle>(
    getStoredActionButtonStyle,
  );

  const handleThemeChange = (mode: ThemeMode) => {
    setTheme(mode);
    applyTheme(mode);
    broadcastSettingsChange(THEME_STORAGE_KEY);
  };

  const handleDesignChange = (mode: DesignMode) => {
    setDesign(mode);
    applyDesign(mode);
    broadcastSettingsChange(DESIGN_STORAGE_KEY);
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

  const handleActionButtonStyleChange = (value: ActionButtonStyle) => {
    setActionButtonStyle(value);
    applyActionButtonStyle(value);
    broadcastSettingsChange(ACTION_BUTTON_STYLE_STORAGE_KEY);
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
        label="Design"
        caption="Experimental layout variant — combines with any theme"
      >
        <SegmentedControl
          aria-label="Design"
          size="default"
          value={design}
          options={DESIGN_OPTIONS}
          onChange={handleDesignChange}
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
        label="Bottom bar buttons"
        caption="Pill: hotkey and label in one frame. Standard: hotkey in a button, label beside it"
      >
        <SegmentedControl
          aria-label="Bottom bar buttons"
          size="default"
          value={actionButtonStyle}
          options={ACTION_BUTTON_OPTIONS}
          onChange={handleActionButtonStyleChange}
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
