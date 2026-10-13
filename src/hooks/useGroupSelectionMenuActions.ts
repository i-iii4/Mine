import { useCallback, useEffect, useMemo, useState } from "react";
import type { MembershipAnswer } from "@/components/CollectionPicker";
import { errorMessage } from "@/lib/errorMessage";
import { patchTagLookup, scheduleAfterOptimisticUiUpdate } from "@/lib/groupSelection";
import type { LightBlock } from "@/types";

interface GroupSelectionMenuActionsInput {
  selectedBlocks: readonly LightBlock[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => MembershipAnswer;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<unknown>;
}

interface GroupSelectionMenuActions {
  selectedSlugs: string[];
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
  tagLookup: Map<string, string[]>;
  /// Why the selection's collections could not be read for the picker. A
  /// change that failed is the tab's notice, not this: the menu that made it
  /// may be closed by then (SPEC_DEEP_AUDIT.md, Н11, Е6.1).
  actionError: string | null;
  batchSetTag: (targetSlugs: string[], tag: string, connected: boolean) => Promise<boolean>;
  createAndAssignBatch: (tag: string) => void;
  /// Disconnect the selection from the open collection; answers whether it
  /// was made, and the caller clears the selection only then.
  disconnectFromCurrentCollection: () => Promise<boolean>;
}

/// Collection actions shared by every entry point into the group selection's
/// commands — the commands row, the ⌘K card menu and the right-click context
/// menu.
///
/// The three are built on different Radix primitives and cannot share
/// markup, but they must not drift in behaviour: all write the same optimistic
/// tag lookup and all hit the same batch command.
export function useGroupSelectionMenuActions({
  selectedBlocks,
  currentTag,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
}: GroupSelectionMenuActionsInput): GroupSelectionMenuActions {
  const selectedSlugs = useMemo(
    () => selectedBlocks.map((block) => block.slug),
    [selectedBlocks],
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [tagLookup, setTagLookup] = useState<Map<string, string[]>>(new Map());
  const [actionError, setActionError] = useState<string | null>(null);

  const loadTags = useCallback((slugs: string[]) => {
    return onLoadBlockTags(slugs).then(
      (lookup) => {
        setTagLookup(lookup);
        setActionError(null);
      },
      (err: unknown) => {
        setActionError(errorMessage(err));
      },
    );
  }, [onLoadBlockTags]);

  useEffect(() => {
    if (!connectOpen || selectedSlugs.length === 0) return;
    let cancelled = false;
    void onLoadBlockTags(selectedSlugs).then(
      (lookup) => {
        if (cancelled) return;
        setTagLookup(lookup);
        setActionError(null);
      },
      (err: unknown) => {
        if (!cancelled) setActionError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connectOpen, onLoadBlockTags, selectedSlugs]);

  const batchSetTag = useCallback((
    targetSlugs: string[],
    tag: string,
    connected: boolean,
  ): Promise<boolean> => {
    if (targetSlugs.length === 0) return Promise.resolve(true);
    setTagLookup((current) => patchTagLookup(current, targetSlugs, tag, connected));
    // The rows change at once; the command runs after that frame
    // (SPEC_GROUP_SELECTION.md, «Batch Connect»).
    return new Promise<boolean>((resolve) => {
      scheduleAfterOptimisticUiUpdate(() => {
        void Promise.resolve(onBatchSetTag(targetSlugs, tag, connected)).then((answer) => {
          const applied = answer !== false;
          // Not made: the rows show the selection as it is again.
          if (!applied) void loadTags(selectedSlugs);
          resolve(applied);
        });
      });
    });
  }, [loadTags, onBatchSetTag, selectedSlugs]);

  const createAndAssignBatch = useCallback((tag: string) => {
    setTagLookup((current) => patchTagLookup(current, selectedSlugs, tag, true));
    scheduleAfterOptimisticUiUpdate(() => {
      void onCreateAndAssignBatch(tag, selectedSlugs);
    });
  }, [onCreateAndAssignBatch, selectedSlugs]);

  const disconnectFromCurrentCollection = useCallback((): Promise<boolean> => {
    if (!currentTag) return Promise.resolve(false);
    return batchSetTag(selectedSlugs, currentTag, false);
  }, [batchSetTag, currentTag, selectedSlugs]);

  return {
    selectedSlugs,
    connectOpen,
    setConnectOpen,
    tagLookup,
    actionError,
    batchSetTag,
    createAndAssignBatch,
    disconnectFromCurrentCollection,
  };
}
