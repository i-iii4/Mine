import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionButton } from "@/components/ActionButton";
import {
  CHANNEL_DISPLAY_MODES,
  DETAIL_TOP_MENU_MODES,
  type ChannelDisplayMode,
  type DetailTopMenuMode,
} from "@/lib/appPreferences";

type ThemeMode = "system" | "light" | "dark";

function getStoredTheme(): ThemeMode {
  return (localStorage.getItem("theme") as ThemeMode) ?? "system";
}

function applyTheme(mode: ThemeMode) {
  localStorage.setItem("theme", mode);
  const root = document.documentElement;

  if (mode === "system") {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "";
  } else {
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
  }
}

export interface ThemeMenuHandle {
  toggle: () => void;
}

interface ThemeMenuButtonProps {
  detailTopMenuMode: DetailTopMenuMode;
  channelDisplayMode: ChannelDisplayMode;
  onDetailTopMenuModeChange: (mode: DetailTopMenuMode) => void;
  onChannelDisplayModeChange: (mode: ChannelDisplayMode) => void;
}

export const ThemeMenuButton = forwardRef<ThemeMenuHandle, ThemeMenuButtonProps>(function ThemeMenuButton({
  detailTopMenuMode,
  channelDisplayMode,
  onDetailTopMenuModeChange,
  onChannelDisplayModeChange,
}, ref) {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  useImperativeHandle(ref, () => ({ toggle }), [toggle]);

  const labels: Record<ThemeMode, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  };
  const detailTopMenuLabels: Record<DetailTopMenuMode, string> = {
    classic: "Article menu: Classic",
    island: "Article menu: Island",
  };
  const channelDisplayLabels: Record<ChannelDisplayMode, string> = {
    row: "Channels: Rows",
    card: "Channels: Cards",
  };

  return (
    <DropdownMenu open={open} onOpenChange={(v) => {
      setOpen(v);
      if (!v) requestAnimationFrame(() => (document.activeElement as HTMLElement)?.blur());
    }}>
      <DropdownMenuTrigger asChild>
        <div className="inline-flex outline-0">
          <ActionButton hotkey="⌘," isSelected={open}>
            Settings
          </ActionButton>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        {(["system", "light", "dark"] as const).map((mode) => (
          <DropdownMenuItem
            key={mode}
            onSelect={() => setTheme(mode)}
            className={theme === mode ? "bg-accent" : ""}
          >
            {labels[mode]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {DETAIL_TOP_MENU_MODES.map((mode) => (
          <DropdownMenuItem
            key={mode}
            onSelect={() => onDetailTopMenuModeChange(mode)}
            className={detailTopMenuMode === mode ? "bg-accent" : ""}
          >
            {detailTopMenuLabels[mode]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {CHANNEL_DISPLAY_MODES.map((mode) => (
          <DropdownMenuItem
            key={mode}
            onSelect={() => onChannelDisplayModeChange(mode)}
            className={channelDisplayMode === mode ? "bg-accent" : ""}
          >
            {channelDisplayLabels[mode]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
