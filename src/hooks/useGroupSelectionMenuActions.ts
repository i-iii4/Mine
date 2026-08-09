import { useCallback, useEffect, useMemo, useState } from "react";
import { patchTagLookup, scheduleAfterOptimisticUiUpdate } from "@/lib/groupSelection";
import type { LightBlock } from "@/types";

interface GroupSelectionMenuActionsInput {
  selectedBlocks: readonly LightBlock[];
  currentTag?: string;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
}

interface GroupSelectionMenuActions {
  selectedSlugs: string[];
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
  tagLookup: Map<string, string[]>;
  actionError: string | null;
  batchSetTag: (targetSlugs: string[], tag: string, connected: boolean) => void;
  createAndAssignBatch: (tag: string) => void;
  disconnectFromCurrentCollection: () => void;
}

/// Collection actions shared by every entry point into the group-selection
/// menu — the ⌘K card menu and the right-click context menu.
///
/// The two menus are built on different Radix primitives and cannot share
/// markup, but they must not drift in behaviour: both write the same optimistic
/// tag lookup and both hit the same batch commands.
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

  useEffect(() => {
    if (!connectOpen || selectedSlugs.length === 0) return;
    let cancelled = false;
    void onLoadBlockTags(selectedSlugs)
      .then((lookup) => {
        if (!cancelled) {
          setTagLookup(lookup);
          setActionError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectOpen, onLoadBlockTags, selectedSlugs]);

  const batchSetTag = useCallback((
    targetSlugs: string[],
    tag: string,
    connected: boolean,
  ) => {
    if (targetSlugs.length === 0) return;
    setTagLookup((current) => patchTagLookup(current, targetSlugs, tag, connected));
    setActionError(null);
    scheduleAfterOptimisticUiUpdate(() => {
      void Promise.resolve(onBatchSetTag(targetSlugs, tag, connected)).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    });
  }, [onBatchSetTag]);

  const createAndAssignBatch = useCallback((tag: string) => {
    setTagLookup((current) => patchTagLookup(current, selectedSlugs, tag, true));
    setActionError(null);
    scheduleAfterOptimisticUiUpdate(() => {
      void Promise.resolve(onCreateAndAssignBatch(tag, selectedSlugs)).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    });
  }, [onCreateAndAssignBatch, selectedSlugs]);

  const disconnectFromCurrentCollection = useCallback(() => {
    if (!currentTag) return;
    batchSetTag(selectedSlugs, currentTag, false);
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
