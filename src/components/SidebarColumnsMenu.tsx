// TRIAL (PLAN 47.6, user's request of 16.10.2026): «Sidebar columns» in the
// Display panel, for the feed and the graph alike. The rows' columns listed in
// their order: dragging one moves it, its switch shows or hides it. The last
// shown column cannot be hidden. Once the user decides, this section either
// goes or becomes a lasting part of the panel.

import { useId } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import {
  SIDEBAR_COLUMN_LABELS,
  SIDEBAR_COLUMNS_STORAGE_KEY,
  setSidebarColumnOrder,
  setSidebarColumnShown,
  useSidebarColumnLayout,
  type SidebarColumn,
} from "@/lib/sidebarColumnLayout";
import { DisplayGroupCaption } from "./DisplayMenu";

/** Keep the change and tell the other tabs and windows. */
function moveColumn(order: readonly SidebarColumn[], from: SidebarColumn, to: SidebarColumn) {
  const next = arrayMove([...order], order.indexOf(from), order.indexOf(to));
  setSidebarColumnOrder(next);
  broadcastSettingsChange(SIDEBAR_COLUMNS_STORAGE_KEY);
}

function showColumn(column: SidebarColumn, shown: boolean) {
  setSidebarColumnShown(column, shown);
  broadcastSettingsChange(SIDEBAR_COLUMNS_STORAGE_KEY);
}

function ColumnItem({
  column,
  shown,
  lastShown,
}: {
  column: SidebarColumn;
  shown: boolean;
  lastShown: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: column });
  const label = SIDEBAR_COLUMN_LABELS[column];
  return (
    <div
      ref={setNodeRef}
      className="flex items-center"
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }}
      data-sidebar-column-item={column}
    >
      <button
        type="button"
        aria-label={`Move ${label}`}
        className="flex size-6 shrink-0 cursor-grab items-center justify-center text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-4" />
      </button>
      <DropdownMenuCheckboxItem
        className="flex-1"
        checked={shown}
        disabled={lastShown}
        onCheckedChange={(checked) => showColumn(column, checked)}
        // The panel stays open: the next change is a click away.
        onSelect={(event) => event.preventDefault()}
      >
        {label}
      </DropdownMenuCheckboxItem>
    </div>
  );
}

/** The trial section of the Display panel: the sidebar rows' columns. */
export function SidebarColumnsMenu() {
  const layout = useSidebarColumnLayout();
  const labelId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const shownCount = layout.order.length - layout.hidden.length;
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = layout.order.find((column) => column === active.id);
    const to = layout.order.find((column) => column === over.id);
    if (from && to) moveColumn(layout.order, from, to);
  };

  return (
    <div role="group" aria-labelledby={labelId} data-sidebar-columns-menu="" data-display-trial="">
      <DisplayGroupCaption id={labelId}>Sidebar columns</DisplayGroupCaption>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={[...layout.order]} strategy={verticalListSortingStrategy}>
          {layout.order.map((column) => {
            const shown = !layout.hidden.includes(column);
            return (
              <ColumnItem key={column} column={column} shown={shown} lastShown={shown && shownCount === 1} />
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
