import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type UniqueIdentifier,
} from "@dnd-kit/core";

function findDroppableContainer(
  args: Parameters<CollisionDetection>[0],
  id: UniqueIdentifier,
) {
  return args.droppableContainers.find((container) => (
    !container.disabled && String(container.id) === String(id)
  )) ?? null;
}

export function sidebarDropIdFromPoint(
  pointerCoordinates: { x: number; y: number } | null,
): string | null {
  if (!pointerCoordinates || typeof document.elementsFromPoint !== "function") {
    return null;
  }

  for (const element of document.elementsFromPoint(pointerCoordinates.x, pointerCoordinates.y)) {
    const row = element.closest<HTMLElement>("[data-sidebar-row]");
    if (!row) continue;

    const rowKey = row.dataset.sidebarRowKey ?? null;
    if (rowKey === "create-channel" || rowKey?.startsWith("tag:")) {
      return rowKey;
    }

    const dropTag = row.dataset.sidebarTextDropTag;
    if (dropTag) {
      return `tag:${dropTag}`;
    }
  }

  return null;
}

export function isCollectionSortDrag(activeId: UniqueIdentifier): boolean {
  return String(activeId).startsWith("tag:");
}

/// Collision detection for the sidebar, split by what is being dragged.
///
/// Dropping something *onto* a collection and sorting collections are different
/// questions and cannot share an answer.
///
/// A drop asks "which row is under the cursor". The rows stand still, so the
/// live DOM is the honest source and `elementsFromPoint` reads it directly —
/// including rows the sortable list never registered.
///
/// A sort asks "between which rows am I". Answering that from the live DOM is a
/// feedback loop: the sortable strategy shifts the rows by transform in
/// response to the answer, the shifted rows change what sits under the cursor,
/// and the target oscillates every pointermove — the shaking this split fixes.
/// Sorting therefore runs on the rects dnd-kit measured at gesture start, and
/// only among the sortable rows, so a stray drop target outside the list cannot
/// blank the target and snap every row back.
///
/// Within that frozen grid the target is the slot under the *pointer*, not the
/// slot nearest the grabbed row's centre: the row hangs off the pointer by
/// wherever the user grabbed it, and `closestCenter` against that rectangle
/// puts the hole up to half a row away from the cursor. `closestCenter` remains
/// only as the fallback for when the pointer leaves the list — above, below or
/// beside it — where "nearest slot" is the honest answer.
export const sidebarPointerWithin: CollisionDetection = (args) => {
  if (isCollectionSortDrag(args.active.id)) {
    const sortableContainers = args.droppableContainers.filter((container) => (
      !container.disabled && isCollectionSortDrag(container.id)
    ));
    if (sortableContainers.length === 0) return [];
    const scoped = { ...args, droppableContainers: sortableContainers };
    const underPointer = pointerWithin(scoped);
    if (underPointer.length > 0) return underPointer;
    return closestCenter(scoped);
  }

  const sidebarDropId = sidebarDropIdFromPoint(args.pointerCoordinates);
  if (sidebarDropId) {
    const droppableContainer = findDroppableContainer(args, sidebarDropId);
    if (droppableContainer) {
      return [{
        id: droppableContainer.id,
        data: {
          droppableContainer,
          value: 0,
          source: "sidebar-pointer",
        },
      }];
    }
  }

  return pointerWithin(args);
};
