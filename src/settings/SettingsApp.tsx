import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChromeRow, ChromeShell } from "@/components/ChromeRow";
import { SETTINGS_SECTIONS, isSettingsSection, type SettingsSection } from "@/lib/settingsSections";
import { GRAPH_PREFERENCES_STORAGE_KEY, reloadGraphPreferences } from "@/lib/graphPreferences";
import { LIGHT_CANVAS_STORAGE_KEY, reloadLightCanvas } from "@/lib/lightCanvas";
import {
  adoptSettingsChange,
  SETTINGS_CHANGED_EVENT,
  type SettingsChangedPayload,
} from "@/lib/settingsChanged";
import { useNativeWindowChromeSurface } from "@/lib/nativeWindowChromeSurface";
import { AppearanceSection } from "./AppearanceSection";
import { GraphSection } from "./GraphSection";
import { listen } from "@tauri-apps/api/event";
import { ShortcutsSection } from "./ShortcutsSection";
import { SpacesSection } from "./SpacesSection";
import { OrphansSection } from "./OrphansSection";
import { LayoutSection } from "./LayoutSection";
import { UpdatesSection } from "./UpdatesSection";

function initialSection(): SettingsSection {
  const asked = new URLSearchParams(window.location.search).get("section");
  return isSettingsSection(asked) ? asked : "appearance";
}

export function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  // An already-open window is told which section to show, since its URL was
  // decided when it was created.
  useEffect(() => {
    const unlisten = listen<string>("settings-section", (event) => {
      if (isSettingsSection(event.payload)) {
        setSection(event.payload);
      }
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  // The graph's Display panel in a tab changes the same links as the Graph
  // section (SPEC_GRAPH_VIEW.md, «Панель графа»): adopt the value it stored
  // and re-read it, so the section shows what the graph draws.
  useEffect(() => {
    const unlisten = listen<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
      if (event.payload.key !== GRAPH_PREFERENCES_STORAGE_KEY) return;
      adoptSettingsChange(event.payload);
      reloadGraphPreferences();
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  // TRIAL (PLAN 47.7): the light canvas chosen in a tab's Display panel.
  useEffect(() => {
    const unlisten = listen<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
      if (event.payload.key !== LIGHT_CANVAS_STORAGE_KEY) return;
      adoptSettingsChange(event.payload);
      reloadLightCanvas();
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  // Keep the native window background in sync with the chrome token so the
  // titlebar overlay area never flashes a mismatched color (same as main).
  useNativeWindowChromeSurface("--chrome");

  return (
    <ChromeShell>
      <ChromeRow as="header" separator="bottom"
        data-tauri-drag-region
        className="bg-chrome"
      >
        {/* No visible title (user's decision of 07.10.2026): the row is
            the drag surface and the traffic lights' reserve. The native
            window title stays "Settings" for the Window menu and Mission
            Control, hidden from the chrome (commands/settings.rs). */}
        <div data-tauri-drag-region data-traffic-light-reserve="" className="w-20 shrink-0" />
        <div data-tauri-drag-region className="flex-1" />
      </ChromeRow>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-[176px] shrink-0 flex-col gap-1 border-r border-border p-2"
        >
          {SETTINGS_SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "true" : undefined}
              onClick={() => setSection(id)}
              className={cn(
                "flex h-8 shrink-0 items-center rounded-1 px-2 text-left font-sans text-base focus-visible:outline-none",
                section === id
                  ? "state-active text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto p-s4">
          {section === "appearance" && <AppearanceSection />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "graph" && <GraphSection />}
          {section === "spaces" && <SpacesSection />}
          {section === "layout" && <LayoutSection />}
          {section === "updates" && <UpdatesSection />}
          {section === "orphans" && <OrphansSection />}
        </main>
      </div>
    </ChromeShell>
  );
}
