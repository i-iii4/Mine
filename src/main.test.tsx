// The tab page's entry: the stored look is on the page before the first
// render (SPEC_SETTINGS_WINDOW.md, «Appearance»), the app renders into
// #root, and no layout variant is written any more (SPEC_DEEP_AUDIT.md, Е8.1).
import { act, screen } from "@testing-library/react";
import { CARD_RADIUS_STORAGE_KEY } from "@/lib/cardRadius";
import { DENSITY_STORAGE_KEY } from "@/lib/density";
import { THEME_STORAGE_KEY } from "@/lib/themeMode";

const firstRender = vi.hoisted(() => ({ theme: undefined as string | null | undefined }));

// The app itself has its own tests; here it only notes what it found.
vi.mock("./App", () => ({
  App: () => {
    firstRender.theme ??= document.documentElement.getAttribute("data-theme");
    return <div data-testid="tab-app">App</div>;
  },
}));

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  for (const name of ["data-theme", "data-design", "data-font-interface", "data-font-content"]) root.removeAttribute(name);
  root.removeAttribute("style");
  document.body.innerHTML = '<div id="root"></div>';
});

it("applies the stored look before the first render and renders the app into #root", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  localStorage.setItem(CARD_RADIUS_STORAGE_KEY, "4");
  localStorage.setItem(DENSITY_STORAGE_KEY, "16");

  await act(async () => {
    await import("./main");
  });

  expect(await screen.findByTestId("tab-app")).toBeInTheDocument();
  expect(document.getElementById("root")).toContainElement(screen.getByTestId("tab-app"));
  expect(firstRender.theme).toBe("dark");
  expect(root.getAttribute("data-font-interface")).toBe("system");
  expect(root.getAttribute("data-font-content")).toBe("system-sans");
  expect(root.style.getPropertyValue("--radius-card")).toBe("4px");
  expect(root.style.getPropertyValue("--edge-rhythm")).toBe("16px");
  expect(root.hasAttribute("data-design")).toBe(false);
  expect(localStorage.getItem("mine.design")).toBeNull();
  // The entry imports the whole app with its stylesheet; under a full parallel run that alone takes about 5 s.
}, 30_000);
