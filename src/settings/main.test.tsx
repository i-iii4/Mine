// The settings window's entry applies the stored look itself before the
// first render, since it cannot rely on the main window for its webview
// (SPEC_SETTINGS_WINDOW.md, «Appearance»), and renders Settings into #root.
// No layout variant is written any more (SPEC_DEEP_AUDIT.md, Е8.1).
import { act, screen } from "@testing-library/react";
import { CARD_RADIUS_STORAGE_KEY } from "@/lib/cardRadius";
import { DENSITY_STORAGE_KEY } from "@/lib/density";
import { THEME_STORAGE_KEY } from "@/lib/themeMode";

const firstRender = vi.hoisted(() => ({ theme: undefined as string | null | undefined }));

// Settings has its own tests; here it only notes what it found.
vi.mock("./SettingsApp", () => ({
  SettingsApp: () => {
    firstRender.theme ??= document.documentElement.getAttribute("data-theme");
    return <div data-testid="settings-app">Settings</div>;
  },
}));

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  for (const name of ["data-theme", "data-design", "data-font-interface", "data-font-content"]) root.removeAttribute(name);
  root.removeAttribute("style");
  document.body.innerHTML = '<div id="root"></div>';
});

it("applies the stored look before the first render and renders Settings into #root", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  localStorage.setItem(CARD_RADIUS_STORAGE_KEY, "4");
  localStorage.setItem(DENSITY_STORAGE_KEY, "24");

  await act(async () => {
    await import("./main");
  });

  expect(await screen.findByTestId("settings-app")).toBeInTheDocument();
  expect(document.getElementById("root")).toContainElement(screen.getByTestId("settings-app"));
  expect(firstRender.theme).toBe("light");
  expect(root.getAttribute("data-font-interface")).toBe("system");
  expect(root.getAttribute("data-font-content")).toBe("system-sans");
  expect(root.style.getPropertyValue("--radius-card")).toBe("4px");
  expect(root.style.getPropertyValue("--edge-rhythm")).toBe("24px");
  expect(root.hasAttribute("data-design")).toBe(false);
  expect(localStorage.getItem("mine.design")).toBeNull();
});
