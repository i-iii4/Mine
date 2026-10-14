// The onboarding screen by screen (SPEC_ONBOARDING.md, О9 to О15): every
// frame is drawn by the production components, the tab bar from a state of
// the current shape, the space's chrome with the props it takes today.
import { render, screen, within } from "@testing-library/react";
import { OnboardingPage } from "./OnboardingPage";

// jsdom does not implement Element.scrollTo, which the feed calls on mount.
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
});

describe("OnboardingPage", () => {
  it("draws every screen of the onboarding with its window", async () => {
    render(<OnboardingPage />);

    const labels = [...document.querySelectorAll("[data-onboarding-step]")].map(step => step.getAttribute("data-onboarding-step"));
    expect(labels).toEqual(["1", "2", "3", "4", "1 →"]);

    // The first launch: the picker, and no space in the tab bar.
    const first = document.querySelector<HTMLElement>('[data-onboarding-step="1"]')!;
    expect(within(first).getByText("Первый запуск")).toBeInTheDocument();
    expect(first.querySelector("[data-vault-picker]")).not.toBeNull();

    // A space's screens name its folder in the tab bar and the switcher.
    const ready = document.querySelector<HTMLElement>('[data-onboarding-step="4"]')!;
    expect((await within(ready).findAllByText("References")).length).toBeGreaterThan(0);
    const empty = document.querySelector<HTMLElement>('[data-onboarding-step="1 →"]')!;
    expect((await within(empty).findAllByText("Moodboard")).length).toBeGreaterThan(0);
    expect(screen.getByText("Системный диалог выбора папки")).toBeInTheDocument();
  });
});
