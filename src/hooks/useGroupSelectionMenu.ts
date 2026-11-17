// The menu of a selection of cards for one of its entry points
// (SPEC_GROUP_SELECTION.md, «Точки входа»): its description as it stands now
// (src/lib/groupSelectionMenu.ts) and the way its choices are carried out,
// with the selection's shared collection actions underneath
// (`useGroupSelectionMenuActions`). The description is drawn by
// `MenuSpecView`, on the page and in the menu panel alike
// (SPEC_MENU_WINDOW.md, МО16, МО23).

import { useCallback, useMemo, useRef } from "react";
import type { MembershipAnswer } from "@/components/CollectionPicker";
import { groupConnectSpec, groupMenuItemId, groupSelectionSpec } from "@/lib/groupSelectionMenu";
import type { LightBlock, MenuAction, MenuAnswer, MenuSpec, TagCount } from "@/types";
import { useCollectionNameCheck } from "./useCollectionNameRefusal";
import { useGroupSelectionMenuActions } from "./useGroupSelectionMenuActions";

export interface GroupSelectionMenuInput {
  selectedBlocks: readonly LightBlock[];
  tags: TagCount[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => MembershipAnswer;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<unknown>;
  /** The feed's `requestDeleteSelection()`: the menu only asks; the window
   *  is the feed's. */
  onRequestDeleteSelection: () => void;
  onMergeSelectedBlocks: () => void;
  onClearSelection: () => void;
}

/** A line the size of the note that says the selection's collections could
 *  not be read: the menu's largest state, for the frame of the menu panel. */
const ERROR_PLACEHOLDER = "The collections could not be read.";

export interface GroupSelectionMenu {
  /** The menu as it stands now. */
  spec: MenuSpec;
  /** The menu at its largest while open: with the note of a failed read. */
  largest: MenuSpec;
  /** Carry out a choice made in the menu. */
  act: (action: MenuAction) => Promise<MenuAnswer>;
  /** The menu opened or closed: while open, the selection's collections are
   *  read for the picker. */
  setOpen: (open: boolean) => void;
  /** Why the selection's collections could not be read, or null: the whole
   *  menu says it in a note, Connect's picker alone leaves it to its row. */
  error: string | null;
}

/**
 * `kind` is the whole menu (⌘K on a card, the right click) or Connect's
 * picker alone (the commands row).
 */
export function useGroupSelectionMenu(kind: "menu" | "connect", input: GroupSelectionMenuInput): GroupSelectionMenu {
  const { selectedBlocks, tags, currentTag } = input;
  const actions = useGroupSelectionMenuActions(input);
  const checkName = useCollectionNameCheck(undefined);
  const { selectedSlugs, tagLookup, actionError } = actions;

  const spec = useMemo(() => {
    const picker = { cards: selectedSlugs, tags, lookup: tagLookup };
    return kind === "connect"
      ? groupConnectSpec(picker)
      : groupSelectionSpec({ count: selectedBlocks.length, inCollection: Boolean(currentTag), error: actionError, picker });
  }, [kind, selectedSlugs, tags, tagLookup, selectedBlocks.length, currentTag, actionError]);

  const largest = useMemo(() => {
    if (kind === "connect" || actionError !== null) return spec;
    const picker = { cards: selectedSlugs, tags, lookup: tagLookup };
    return groupSelectionSpec({ count: selectedBlocks.length, inCollection: Boolean(currentTag), error: ERROR_PLACEHOLDER, picker });
  }, [kind, actionError, spec, selectedSlugs, tags, tagLookup, selectedBlocks.length, currentTag]);

  // What a choice acts on when it comes: the props and the actions as they
  // stand.
  const now = useRef({ input, actions, checkName });
  now.current = { input, actions, checkName };

  const act = useCallback(async (action: MenuAction): Promise<MenuAnswer> => {
    const current = now.current;
    if (action.kind === "run") {
      switch (groupMenuItemId(action.id)) {
        case "disconnect":
          // The selection stays until the answer: a Disconnect that was not
          // made keeps it, to be tried again (SPEC_DEEP_AUDIT.md, Е6.1).
          void current.actions.disconnectFromCurrentCollection().then((applied) => {
            if (applied) current.input.onClearSelection();
          });
          break;
        case "merge":
          current.input.onMergeSelectedBlocks();
          break;
        case "delete":
          current.input.onRequestDeleteSelection();
          break;
        case null:
          break;
      }
      return { kind: "done" };
    }
    // The selection's menu holds no choice of a value and no switch.
    if (action.kind !== "widget") return { kind: "done" };
    switch (action.action.kind) {
      case "connect_cards":
        return {
          kind: "membership",
          made: await current.actions.batchSetTag(current.actions.selectedSlugs, action.action.collection, action.action.connected),
        };
      case "create_collection":
        current.actions.createAndAssignBatch(action.action.name);
        return { kind: "done" };
      case "check_collection_name":
        return { kind: "name_refusal", reason: current.checkName ? await current.checkName(action.action.name) : null };
      // What another widget asks: a selection's picker never does.
      default:
        return { kind: "done" };
    }
  }, []);

  const { setConnectOpen } = actions;
  return useMemo(
    () => ({ spec, largest, act, setOpen: setConnectOpen, error: actionError }),
    [spec, largest, act, setConnectOpen, actionError],
  );
}
