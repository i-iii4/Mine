import { useEffect, lazy, Suspense, useState } from "react";
import { cn } from "@/lib/utils";
import { useNativeWindowChromeSurface } from "@/lib/nativeWindowChromeSurface";
import { AppearanceSection } from "./AppearanceSection";
import { GraphSection } from "./GraphSection";
import { listen } from "@tauri-apps/api/event";
import { ShortcutsSection } from "./ShortcutsSection";
import { SpacesSection } from "./SpacesSection";
import { OrphansSection } from "./OrphansSection";
import { LayoutSection } from "./LayoutSection";
import { ClipperSection } from "./ClipperSection";

/// Loaded on demand: the showcase pulls in every production primitive and has
/// no business weighing down a window opened to change a checkbox.
const ComponentTestBench = lazy(async () => {
  const mod = await import("@/components/ComponentTestBench");
  return { default: mod.ComponentTestBench };
});

type SettingsSection =
  | "appearance"
  | "shortcuts"
  | "graph"
  | "spaces"
  | "layout"
  | "clipper"
  | "orphans"
  | "design-system";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "graph", label: "Graph" },
  { id: "spaces", label: "Spaces" },
  { id: "layout", label: "Folders" },
  { id: "clipper", label: "Extension" },
  { id: "orphans", label: "Orphans" },
  // The design-system showcase: a working surface, not a user setting, which
  // is why it sits last and used to hang off the main window's button bar.
  { id: "design-system", label: "Design system" },
];

function initialSection(): SettingsSection {
  const asked = new URLSearchParams(window.location.search).get("section");
  return SECTIONS.some((entry) => entry.id === asked)
    ? (asked as SettingsSection)
    : "appearance";
}

export function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  // An already-open window is told which section to show, since its URL was
  // decided when it was created.
  useEffect(() => {
    const unlisten = listen<string>("settings-section", (event) => {
      if (SECTIONS.some((entry) => entry.id === event.payload)) {
        setSection(event.payload as SettingsSection);
      }
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  // Keep the native window background in sync with the chrome token so the
  // titlebar overlay area never flashes a mismatched color (same as main).
  useNativeWindowChromeSurface("--chrome");

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <header
        data-tauri-drag-region
        className="flex h-8 shrink-0 items-center border-b border-border bg-chrome"
      >
        <div data-tauri-drag-region data-traffic-light-reserve="" className="w-20 shrink-0" />
        <div data-tauri-drag-region className="flex flex-1 items-center px-3">
          <span className="font-mono text-sm text-muted-foreground">Settings</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-[176px] shrink-0 flex-col gap-1 border-r border-border p-2"
        >
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "true" : undefined}
              onClick={() => setSection(id)}
              className={cn(
                "flex h-8 shrink-0 items-center rounded-1 px-2 text-left font-mono text-sm focus-visible:outline-none",
                section === id
                  ? "bg-active text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <main
          className={cn(
            "min-w-0 flex-1 overflow-y-auto",
            // The showcase brings its own page padding and needs the full
            // width; every other section keeps the settings inset.
            section === "design-system" ? "p-0" : "p-s4",
          )}
        >
          {section === "design-system" && (
            <Suspense fallback={null}>
              <ComponentTestBench />
            </Suspense>
          )}
          {section === "appearance" && <AppearanceSection />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "graph" && <GraphSection />}
          {section === "spaces" && <SpacesSection />}
          {section === "layout" && <LayoutSection />}
          {section === "clipper" && <ClipperSection />}
          {section === "orphans" && <OrphansSection />}
        </main>
      </div>
    </div>
  );
}
