import { useCallback, useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { MemoryRouter } from "react-router";
import { Sidebar, SidebarTagRowDragPreview } from "@/components/Sidebar";
import { sidebarPointerWithin } from "@/lib/sidebarDndCollision";
import {
  TAG_ROW_DROP_ANIMATION,
  TAG_ROW_OVERLAY_MODIFIERS,
} from "@/lib/tagRowDragOverlay";
import type { PreviewCard, TagCount } from "@/types";

/// Browser-audit route for the collection-reorder gesture.
///
/// It mounts the production pieces — Sidebar, sensors, collision detection,
/// overlay dressing — around a local optimistic reorder, so the Playwright
/// audit measures the same gesture the app ships, minus the vault round trip.

const AUDIT_TAGS: TagCount[] = Array.from({ length: 12 }, (_, index) => ({
  tag: `c${String(index).padStart(2, "0")}-collection`,
  count: (index * 7) % 43,
}));

const AUDIT_PREVIEWS = new Map<string, PreviewCard[]>(
  AUDIT_TAGS.map((tc, index) => [
    tc.tag,
    Array.from({ length: 3 }, (_, slot) => ({
      slug: `${tc.tag}-block-${slot}`,
      url: `/feed-scroll-audit/audit-${(index + slot) % 6}.svg`,
      text: false,
      hasThumb: true,
    })),
  ]),
);

function SidebarReorderAuditScene() {
  const [tags, setTags] = useState(AUDIT_TAGS);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith("tag:")) {
      setActiveDragTag(id.slice(4));
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragTag(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || !activeId.startsWith("tag:") || !overId.startsWith("tag:")) return;
    const activeTag = activeId.slice(4);
    const overTag = overId.slice(4);
    // The optimistic path from App.handleReorderTag, without the vault write.
    setTags((current) => {
      const order = current.map((tc) => tc.tag);
      const oldIndex = order.indexOf(activeTag);
      const newIndex = order.indexOf(overTag);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragTag(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarPointerWithin}
      autoScroll={{ canScroll: (el) => el.hasAttribute("data-sidebar-scroll") }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className="flex h-screen w-screen bg-background text-foreground"
        style={{ "--sidebar-width": "340px" } as CSSProperties}
        data-sidebar-reorder-audit-route=""
      >
        <Sidebar
          width={340}
          collapsed={false}
          isResizing={false}
          vaultPath="/tmp/mine-sidebar-reorder-audit"
          orderedTags={tags}
          channelPreviews={AUDIT_PREVIEWS}
          totalBlocks={AUDIT_TAGS.reduce((sum, tc) => sum + tc.count, 0)}
          isDropDragging={false}
          isTagDragging={activeDragTag !== null}
          isCreatingChannel={false}
          onSetCreatingChannel={() => {}}
          onDeleteTag={() => {}}
          onRenameTag={() => {}}
          onCreateChannel={() => {}}
        />
        <main className="flex-1" />
      </div>
      <DragOverlay
        dropAnimation={TAG_ROW_DROP_ANIMATION}
        modifiers={TAG_ROW_OVERLAY_MODIFIERS}
        style={{ pointerEvents: "none" }}
      >
        {activeDragTag && (
          <SidebarTagRowDragPreview
            label={activeDragTag}
            count={tags.find((tc) => tc.tag === activeDragTag)?.count ?? 0}
            cards={AUDIT_PREVIEWS.get(activeDragTag) ?? []}
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

export function SidebarReorderAuditRoute() {
  // Sidebar rows are NavLink and need a router above them.
  return (
    <MemoryRouter initialEntries={["/"]}>
      <SidebarReorderAuditScene />
    </MemoryRouter>
  );
}
