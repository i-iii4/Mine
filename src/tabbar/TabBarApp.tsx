import { useAppearanceSync } from "./appearance";
import { TabBar, TabBarPending } from "./TabBar";
import { useTabBarState } from "./useTabBarState";

/** The tab bar page: the window's state from the backend, drawn as one row. */
export function TabBarApp() {
  useAppearanceSync();
  const { bar, dropHover } = useTabBarState();
  return bar === null ? <TabBarPending /> : <TabBar bar={bar} dropHover={dropHover} />;
}
