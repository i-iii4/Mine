// Places the audit's inventory of motion left out, the Switch and the
// ScrollArea's bar, move as Отклик (SPEC_MOTION_LEVELS.md, РД7, «Места,
// которых нет в описи»): 150 ms to a new state on the response curve, not
// Tailwind's own 150 ms default, by the role's tokens.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollArea, ScrollBar } from "./scroll-area";
import { Switch } from "./switch";

describe("the roles of the unlisted primitives", () => {
  it("moves a Switch's track and thumb as Отклик", () => {
    const { container } = render(<Switch aria-label="Trial" />);
    const track = container.querySelector('[data-slot="switch"]');
    const thumb = container.querySelector('[data-slot="switch-thumb"]');
    for (const part of [track, thumb]) {
      expect(part).toHaveClass("duration-(--motion-enter)", "ease-(--motion-ease)");
    }
  });

  it("colours a ScrollArea's bar as Отклик", () => {
    const { container } = render(
      <ScrollArea type="always">
        <div style={{ height: 400 }}>Rows</div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>,
    );
    const bars = container.querySelectorAll('[data-slot="scroll-area-scrollbar"]');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar).toHaveClass("transition-colors", "duration-(--motion-enter)", "ease-(--motion-ease)");
  });
});
