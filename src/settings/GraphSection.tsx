import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  getStoredGraphPreferences,
  GRAPH_PREFERENCES_STORAGE_KEY,
  storeGraphPreferences,
  type GraphPreferences,
} from "@/lib/graphPreferences";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import { SettingRow } from "./SettingRow";

type GraphPreferenceKey = keyof GraphPreferences;

export function GraphSection() {
  const [preferences, setPreferences] = useState(getStoredGraphPreferences);

  const updatePreference = (key: GraphPreferenceKey, checked: boolean) => {
    const next = { ...preferences, [key]: checked };
    setPreferences(next);
    storeGraphPreferences(next);
    broadcastSettingsChange(GRAPH_PREFERENCES_STORAGE_KEY);
  };

  return (
    <section className="flex flex-col gap-s3">
      <h1 className="text-lg font-semibold">Graph</h1>

      <SettingRow
        label="Collections"
        caption="Show collection nodes and membership links"
      >
        <Checkbox
          aria-label="Collections"
          checked={preferences.include_collections}
          onCheckedChange={(checked) => (
            updatePreference("include_collections", checked === true)
          )}
        />
      </SettingRow>

      <SettingRow
        label="Wikilinks"
        caption="Show links between existing notes"
      >
        <Checkbox
          aria-label="Wikilinks"
          checked={preferences.include_wikilinks}
          onCheckedChange={(checked) => (
            updatePreference("include_wikilinks", checked === true)
          )}
        />
      </SettingRow>

      <SettingRow
        label="Related notes"
        caption="Show provenance links recorded by Mine"
      >
        <Checkbox
          aria-label="Related notes"
          checked={preferences.include_related_notes}
          onCheckedChange={(checked) => (
            updatePreference("include_related_notes", checked === true)
          )}
        />
      </SettingRow>
    </section>
  );
}
