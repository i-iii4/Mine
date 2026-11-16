// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the
// menu panel's entry applies the stored look before the first render, its
// page and window are clear, and the build makes the page.
import { readFileSync } from "node:fs";
import { act, screen } from "@testing-library/react";
import { THEME_STORAGE_KEY } from "@/lib/themeMode";
import { applyMenuPanelButtons } from "./appearance";

const firstRender = vi.hoisted(() => ({ theme: undefined as string | null | undefined }));

vi.mock("./MenuPanelApp", () => ({
  MenuPanelApp: () => {
    firstRender.theme ??= document.documentElement.getAttribute("data-theme");
    return <div data-testid="menu-panel-app" />;
  },
}));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = '<div id="root"></div>';
});

it("applies the stored look before the first render and renders the panel into #root", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  await act(async () => {
    await import("./main");
  });
  expect(await screen.findByTestId("menu-panel-app")).toBeInTheDocument();
  expect(firstRender.theme).toBe("dark");
}, 30_000);

it("is a clear page, its root by the root's own id, and a page of the build", () => {
  const html = readFileSync("menu-panel.html", "utf8");
  expect(html).toContain('<html lang="en" data-menu-panel>');
  expect(html).toContain('src="/src/menuPanel/main.tsx"');
  const css = readFileSync("src/menuPanel/menuPanel.css", "utf8");
  // global.css paints `#root` by its id: the panel's rule names the id too
  // (the browser check holds the pixels, scripts/menu-panel-audit.mjs).
  expect(css).toMatch(/html\[data-menu-panel\],\s*html\[data-menu-panel\] body,\s*html\[data-menu-panel\] #root \{\s*background: transparent;/);
  expect(readFileSync("vite.config.ts", "utf8")).toContain('menuPanel: path.resolve(__dirname, "menu-panel.html")');
  const capabilities = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as { webviews: string[] };
  expect(capabilities.webviews).toContain("menu-panel");
});

it("draws the buttons in the style of the window the menu came from", () => {
  applyMenuPanelButtons("retro");
  expect(document.documentElement.getAttribute("data-buttons")).toBe("retro");
  applyMenuPanelButtons(null);
  expect(document.documentElement.hasAttribute("data-buttons")).toBe(false);
});
