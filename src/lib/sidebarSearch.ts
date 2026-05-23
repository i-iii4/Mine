import type { TagCount } from "@/types";
import { collectionRefLabel } from "@/lib/collections";
import {
  filterAndRankChannelSearch,
  normalizeChannelSearchText,
} from "@/lib/channelSearch";

export const SIDEBAR_ALL_ROW_KEY = "all";
export const SIDEBAR_CREATE_CHANNEL_ROW_KEY = "create-channel";

export function sidebarRowDomId(rowKey: string): string {
  return `sidebar-row-${encodeURIComponent(rowKey)}`;
}

export function filterSidebarTags(
  orderedTags: readonly TagCount[],
  searchQuery: string,
): TagCount[] {
  return searchQuery.trim()
    ? filterAndRankChannelSearch(
        orderedTags.map((tc) => ({
          item: tc,
          texts: [collectionRefLabel(tc.tag), tc.tag],
        })),
        searchQuery,
      )
    : [...orderedTags];
}

export function shouldShowSidebarEverythingRow(searchQuery: string): boolean {
  const normalizedSearchQuery = normalizeChannelSearchText(searchQuery);
  return normalizedSearchQuery
    ? "everything".includes(normalizedSearchQuery)
      || "all".includes(normalizedSearchQuery)
      || "__all__".includes(normalizedSearchQuery)
    : true;
}

export function buildSidebarRowOrder(
  visibleTags: readonly TagCount[],
  includeEverythingRow: boolean,
  includeCreateRow = false,
): string[] {
  const rowKeys = [
    ...(includeEverythingRow ? [SIDEBAR_ALL_ROW_KEY] : []),
    ...visibleTags.map((tc) => `tag:${tc.tag}`),
  ];
  if (includeCreateRow) {
    rowKeys.push(SIDEBAR_CREATE_CHANNEL_ROW_KEY);
  }
  return rowKeys;
}

export function buildSidebarSearchNavigationRows(
  orderedTags: readonly TagCount[],
  searchQuery: string,
): string[] {
  return buildSidebarRowOrder(
    filterSidebarTags(orderedTags, searchQuery),
    shouldShowSidebarEverythingRow(searchQuery),
    true,
  );
}

export function sidebarRowKeyToRoute(rowKey: string): string | null {
  if (rowKey === SIDEBAR_ALL_ROW_KEY) {
    return "/";
  }
  if (rowKey.startsWith("tag:")) {
    return `/channel/${encodeURIComponent(rowKey.slice(4))}`;
  }
  return null;
}
