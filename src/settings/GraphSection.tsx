import { Checkbox } from "@/components/ui/checkbox";
import {
  setGraphPreference,
  useGraphPreferences,
} from "@/lib/graphPreferences";
import { SettingRow } from "./SettingRow";

// The same two switches as the graph's Display panel, on the same value
// (SPEC_GRAPH_VIEW.md, «Панель графа»). Collections are always drawn and have
// no switch here either.
export function GraphSection() {
  const preferences = useGraphPreferences();

  return (
    <section className="flex flex-col gap-s3">
      <h1 className="text-base font-semibold">Graph</h1>

      <SettingRow
        label="Wikilinks"
        caption="Show links between existing notes"
      >
        <Checkbox
          aria-label="Wikilinks"
          checked={preferences.include_wikilinks}
          onCheckedChange={(checked) => (
            setGraphPreference("include_wikilinks", checked === true)
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
            setGraphPreference("include_related_notes", checked === true)
          )}
        />
      </SettingRow>
    </section>
  );
}
