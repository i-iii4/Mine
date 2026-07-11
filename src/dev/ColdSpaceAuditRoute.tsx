import { useCallback, useEffect, useState } from "react";
import { Grid } from "@/components/Grid";
import type { GridSnapshot } from "@/types";

interface ColdSpaceBrowserPayload {
  source_root: string;
  thumbs_root_path: string;
  first: GridSnapshot;
  settled: GridSnapshot;
}

declare global {
  interface Window {
    __MINE_COLD_SPACE_AUDIT__?: {
      stage: "first" | "settled";
      blockCount: number;
      generation: number;
      sourceRoot: string;
      settle: () => void;
    };
  }
}

function noop() {
  return undefined;
}

export function ColdSpaceAuditRoute() {
  const [payload, setPayload] = useState<ColdSpaceBrowserPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"first" | "settled">("first");
  const settle = useCallback(() => setStage("settled"), []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/__cold-space-snapshot", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`cold-space snapshot request failed: ${response.status}`);
        }
        return response.json() as Promise<ColdSpaceBrowserPayload>;
      })
      .then(setPayload)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, []);

  const snapshot = payload ? payload[stage] : null;
  useEffect(() => {
    if (!payload || !snapshot) return;
    window.__MINE_COLD_SPACE_AUDIT__ = {
      stage,
      blockCount: snapshot.blocks.length,
      generation: snapshot.generation,
      sourceRoot: payload.source_root,
      settle,
    };
    return () => {
      delete window.__MINE_COLD_SPACE_AUDIT__;
    };
  }, [payload, settle, snapshot, stage]);

  if (error) {
    throw new Error(error);
  }
  if (!payload || !snapshot) {
    return <main className="h-screen w-screen bg-background" data-cold-space-loading="" />;
  }

  return (
    <main
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
      data-cold-space-audit-route=""
      data-cold-space-stage={stage}
      data-cold-space-generation={snapshot.generation}
    >
      <Grid
        blocks={snapshot.blocks}
        vaultPath={payload.source_root}
        thumbsRootPath={payload.thumbs_root_path}
        tags={[]}
        currentTag={undefined}
        scrollToTop={0}
        keyboardNavigationDisabled
        heightDriftAuditMode
        onBlockClick={noop}
        onToggleTag={noop}
        onCreateAndAssign={noop}
        onLoadBlockTags={async () => new Map()}
        onBatchSetTag={noop}
        onCreateAndAssignBatch={noop}
        onDeleteSelectedBlocks={noop}
        onMergeSelectedBlocks={noop}
        onRequestRename={noop}
        onRequestDelete={noop}
      />
    </main>
  );
}
