export const GRAPH_PREFERENCES_STORAGE_KEY = "mine.graphPreferences";

export interface GraphPreferences {
  include_collections: boolean;
  include_wikilinks: boolean;
  include_related_notes: boolean;
}

export const DEFAULT_GRAPH_PREFERENCES: Readonly<GraphPreferences> = {
  include_collections: true,
  include_wikilinks: true,
  include_related_notes: true,
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function getStoredGraphPreferences(): GraphPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_GRAPH_PREFERENCES };
  const raw = window.localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_GRAPH_PREFERENCES };

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return { ...DEFAULT_GRAPH_PREFERENCES };
    }
    const stored = value as Record<string, unknown>;
    return {
      include_collections: readBoolean(
        stored.include_collections,
        DEFAULT_GRAPH_PREFERENCES.include_collections,
      ),
      include_wikilinks: readBoolean(
        stored.include_wikilinks,
        DEFAULT_GRAPH_PREFERENCES.include_wikilinks,
      ),
      include_related_notes: readBoolean(
        stored.include_related_notes,
        DEFAULT_GRAPH_PREFERENCES.include_related_notes,
      ),
    };
  } catch {
    return { ...DEFAULT_GRAPH_PREFERENCES };
  }
}

export function storeGraphPreferences(preferences: GraphPreferences): void {
  window.localStorage.setItem(
    GRAPH_PREFERENCES_STORAGE_KEY,
    JSON.stringify(preferences),
  );
}
