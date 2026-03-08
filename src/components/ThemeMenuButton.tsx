import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionButton } from "@/components/ActionButton";

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

export const ThemeMenuButton = forwardRef<ThemeMenuHandle>(function ThemeMenuButton(_, ref) {
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
