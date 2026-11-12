// The buttons of a search or Related notes row (SPEC_MOTION_LEVELS.md, Л7):
// they answer the pointer on the hover answers' tokens, so Minimal keeps
// their 150/100 ms and Off lands them at once through those tokens.
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { lightBlock } from "@/test/blocks";
import { CardRowActions } from "./CardRowActions";
import { TooltipProvider } from "./ui/tooltip";

function row(visible: boolean) {
  return render(
    <TooltipProvider>
      <CardRowActions
        block={lightBlock({ slug: "Cards/One" })}
        vaultPath="/vault"
        tags={[]}
        visible={visible}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onMenuOpenChange={vi.fn()}
        onMenuCloseAutoFocus={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("a row's buttons on the motion levels (Л7)", () => {
  it("fade in on the hover answers' fade-in token and out on the fade-out token", () => {
    const shown = row(true).container.querySelector("[data-card-row-actions]");
    expect(shown).toHaveClass("transition-opacity", "duration-[var(--hover-intent-fade-in)]");
    const hidden = row(false).container.querySelector("[data-card-row-actions]");
    expect(hidden).toHaveClass("transition-opacity", "duration-[var(--hover-intent-fade-out)]");
  });
});
