// The sidebar's filter as a drop target (decision of 16.11.2026): a card,
// cards, a picture or a selected text dropped on it found an untitled
// collection with them, the one way to make a collection by a drag
// (DESIGN_SYSTEM.md, «Создание коллекции»). It answers the drag as a row of
// collections does: its text comes up bright, Отклик (global.css,
// `data-sidebar-search-drop-over`).

import type { HTMLAttributes } from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SIDEBAR_SEARCH_DROP_ID, isCollectionSortDrag } from "@/lib/sidebarDndCollision";

export function SidebarSearchDropTarget({
  remoteOver,
  ...surface
}: HTMLAttributes<HTMLDivElement> & {
  /** Cards dragged in another window of the space are over it (SPEC_OUTSIDE_WINDOW.md, ПК4). */
  remoteOver: boolean;
}) {
  const { active } = useDndContext();
  // A row of collections being sorted is no drop: only what a collection takes.
  const dropping = active !== null && !isCollectionSortDrag(active.id);
  const { setNodeRef, isOver } = useDroppable({ id: SIDEBAR_SEARCH_DROP_ID, disabled: !dropping });
  return (
    <div
      ref={setNodeRef}
      {...surface}
      data-sidebar-search-drop=""
      data-sidebar-search-drop-over={(dropping && isOver) || remoteOver ? "" : undefined}
    />
  );
}
