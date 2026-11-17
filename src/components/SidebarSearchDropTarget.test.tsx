import { readFileSync } from "node:fs";
import { DndContext } from "@dnd-kit/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarSearchDropTarget } from "./SidebarSearchDropTarget";

/// Decision of 16.11.2026: the sidebar's filter is the drop that founds a
/// collection, and it answers as a row of collections does.
describe("the sidebar's filter as a drop target", () => {
  function surface(remoteOver: boolean) {
    const { container } = render(
      <DndContext>
        <SidebarSearchDropTarget remoteOver={remoteOver} data-sidebar-top-search-surface="">
          <input data-sidebar-top-search="" />
        </SidebarSearchDropTarget>
      </DndContext>,
    );
    return container.querySelector<HTMLElement>("[data-sidebar-search-drop]")!;
  }

  it("is the surface the pointer finds it by, quiet with no drag over it", () => {
    const target = surface(false);
    expect(target).toHaveAttribute("data-sidebar-top-search-surface", "");
    expect(target).not.toHaveAttribute("data-sidebar-search-drop-over");
  });

  it("answers cards dragged in another window over it", () => {
    expect(surface(true)).toHaveAttribute("data-sidebar-search-drop-over", "");
  });

  it("brightens its text as a row's name, on Отклик's times", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).toMatch(/\[data-sidebar-search-drop\] \[data-sidebar-top-search\],\s*\[data-sidebar-search-drop\] \[data-sidebar-top-search\]::placeholder \{\s*transition: color var\(--motion-exit\) var\(--motion-ease\);/);
    expect(css).toMatch(/\[data-sidebar-search-drop\]\[data-sidebar-search-drop-over\] \[data-sidebar-top-search\]::placeholder \{\s*color: var\(--foreground\);\s*transition-duration: var\(--motion-enter\);/);
  });
});
