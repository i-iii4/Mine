import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { setTheme as setTauriTheme } from "@tauri-apps/api/app";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionButton } from "@/components/ActionButton";

type ThemeMode = "system" | "light" | "dark";

function getStoredTheme(): ThemeMode {
  const stored = localStorage.getItem("theme");
  // High Contrast was merged into Dark; migrate any previously saved value so
  // users who had it selected land on the (now identical) Dark theme.
  if (stored === "high-contrast") return "dark";
  return (stored as ThemeMode) ?? "system";
}

function applyTheme(mode: ThemeMode) {
  localStorage.setItem("theme", mode);
  const root = document.documentElement;

  if (mode === "system") {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "";
    void setTauriTheme(null).catch(() => {});
  } else {
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
    void setTauriTheme(mode).catch(() => {});
  }
}

export interface ThemeMenuHandle {
  toggle: () => void;
}

interface ThemeMenuButtonProps {
  compactDetailTopMenuEnabled?: boolean;
  onCompactDetailTopMenuChange?: (enabled: boolean) => void;
  bottomActionBarHidden?: boolean;
  onBottomActionBarHiddenChange?: (hidden: boolean) => void;
  menuSide?: "top" | "bottom";
}

export const ThemeMenuButton = forwardRef<ThemeMenuHandle, ThemeMenuButtonProps>(function ThemeMenuButton(
  {
    compactDetailTopMenuEnabled = false,
    onCompactDetailTopMenuChange,
    bottomActionBarHidden = false,
    onBottomActionBarHiddenChange,
    menuSide = "top",
  },
  ref,
) {
  const [theme, setThemeMode] = useState<ThemeMode>(getStoredTheme);
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
      <DropdownMenuContent align="start" side={menuSide}>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setThemeMode(value as ThemeMode)}
        >
          {(["system", "light", "dark"] as const).map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode}>
              {labels[mode]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={compactDetailTopMenuEnabled}
          onCheckedChange={(checked) => onCompactDetailTopMenuChange?.(checked === true)}
        >
          Compact Detail top menu
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={bottomActionBarHidden}
          onCheckedChange={(checked) => onBottomActionBarHiddenChange?.(checked === true)}
        >
          Hide bottom menu
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
