import {
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

export const sidebarPointerWithin: CollisionDetection = (args) => {
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
