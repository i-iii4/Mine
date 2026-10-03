import { Columns2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/// Hides and shows the sidebar from the top chrome, right of the window's
/// traffic lights. It stays at that spot in both states, so the pointer finds
/// it where it left it. The same command as View → Hide Sidebar (⌃⌘S), the
/// bottom bar and the two-finger swipe: one state, `useSidebarResize`.
/// The glyph is two equal panes, not `PanelLeft`'s narrow strip: Mine's left
/// pane holds the collections with their previews and is often as wide as the
/// feed, so the window it toggles is two panes (user's decision, 02.10.2026).
export function SidebarToggleButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show Sidebar" : "Hide Sidebar";
  return (
    <Button
      type="button"
      variant="chrome"
      size="chrome-icon"
      // It stands in the tab bar, a page one row tall: a tooltip would be
      // cut off there.
      tooltip={false}
      aria-label={label}
      aria-pressed={!collapsed}
      onClick={onToggle}
      data-top-chrome-sidebar-toggle=""
    >
      <Columns2 />
      <span className="sr-only">{label}</span>
    </Button>
  );
}
