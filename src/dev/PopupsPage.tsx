// Every modal window of the app, one button each, for a look at them.
//
// The windows are the production components with props written here; their
// handlers do nothing. A window whose host keeps the open state to itself is
// opened through the host's own control, drawn here as it is.

import { useState, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { MemoryRouter } from "react-router";
import { CreateCollectionDialog } from "@/components/CreateCollectionDialog";
import { DeleteBlockDialog } from "@/components/DeleteBlockDialog";
import { DeleteSelectedCardsDialog } from "@/components/DeleteSelectedCardsDialog";
import { GroupSelectionCommands } from "@/components/GroupSelectionCommands";
import { ImportDialog } from "@/components/ImportDialog";
import { MergeCardsDialog } from "@/components/MergeCardsDialog";
import { RenameBlockDialog } from "@/components/RenameBlockDialog";
import { SearchOverlay } from "@/components/SearchOverlay";
import { Sidebar } from "@/components/Sidebar";
import { TopCollectionSwitcher } from "@/components/TopCollectionSwitcher";
import { Button } from "@/components/ui/button";
import type { DeleteBlockPlan, LightBlock, PreviewCard, TagCount } from "@/types";

const VAULT_PATH = "/Users/me/References";

function noop() {
  return undefined;
}

async function noopAsync() {
  return undefined;
}

async function noTags() {
  return new Map<string, string[]>();
}

function block(id: number, title: string): LightBlock {
  return {
    id,
    slug: `popup-${id}`,
    card_kind: "article",
    block_type: "article",
    title,
    content_heading: null,
    display_title: title,
    fallback_label: title,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-10-08T12:00:00.000Z",
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    search_match: null,
    collections: [],
  };
}

const BLOCKS: LightBlock[] = [
  block(1, "Local-first software"),
  block(2, "CRDTs explained"),
  block(3, "Designing calm interfaces"),
];

const TAGS: TagCount[] = [
  { tag: "Красивый веб", count: 12 },
  { tag: "Typography", count: 5 },
];

const CHANNEL_PREVIEWS = new Map<string, PreviewCard[]>(TAGS.map((tag) => [tag.tag, []]));

const DELETE_PLAN: DeleteBlockPlan = {
  slug: "popup-1",
  markdown_file: "Cards/popup-1.md",
  unused_media: [],
  shared_media: [],
};

type DialogId =
  | "rename"
  | "merge"
  | "delete-selected"
  | "create-collection"
  | "delete-block"
  | "import"
  | "search";

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border py-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {hint && <div className="text-sm text-muted-foreground">{hint}</div>}
      <div>{children}</div>
    </section>
  );
}

export function PopupsPage() {
  const [open, setOpen] = useState<DialogId | null>(null);
  const [query, setQuery] = useState("");
  const openChange = (id: DialogId) => (next: boolean) => setOpen(next ? id : null);
  const show = (id: DialogId, label: string) => (
    <Button variant="secondary" onClick={() => setOpen(id)}>{label}</Button>
  );

  return (
    <MemoryRouter initialEntries={["/"]}>
      <DndContext>
        <div className="min-h-screen bg-background px-6 py-6 text-foreground">
          <h1 className="text-lg font-medium">Popups</h1>

          <Row title="RenameBlockDialog">{show("rename", "Rename file")}</Row>
          <Row title="MergeCardsDialog">{show("merge", "Merge cards")}</Row>
          <Row title="DeleteSelectedCardsDialog">{show("delete-selected", "Delete selected")}</Row>
          <Row title="CreateCollectionDialog">{show("create-collection", "New collection")}</Row>
          <Row title="DeleteBlockDialog">{show("delete-block", "Delete element")}</Row>
          <Row title="ImportDialog">{show("import", "Import from Are.na")}</Row>
          <Row title="SearchOverlay" hint="Results come from the backend: here the list stays empty.">
            {show("search", "Search")}
          </Row>
          <Row title="TopCollectionSwitcher: Create collection" hint="Open the menu, then Create collection.">
            <div className="flex h-10 items-center">
              <TopCollectionSwitcher
                orderedTags={TAGS}
                onNavigate={noop}
                onCreateCollection={noop}
              />
            </div>
          </Row>
          <Row title="GroupSelectionCommands: Delete selected elements" hint="Delete in the selection bar.">
            <GroupSelectionCommands
              selectedBlocks={BLOCKS.slice(0, 2)}
              tags={TAGS}
              onLoadBlockTags={noTags}
              onBatchSetTag={noop}
              onCreateAndAssignBatch={noop}
              onDeleteSelectedBlocks={noop}
              onMergeSelectedBlocks={noop}
              onClearSelection={noop}
            />
          </Row>
          <Row title="Sidebar: Delete channel" hint="Right-click a collection row, then Delete.">
            <div className="relative flex h-80 overflow-hidden border border-border">
              <Sidebar
                width={300}
                collapsed={false}
                isResizing={false}
                vaultPath={VAULT_PATH}
                tags={TAGS}
                orderedTags={TAGS}
                channelPreviews={CHANNEL_PREVIEWS}
                totalBlocks={BLOCKS.length}
                isDropDragging={false}
                isCreatingChannel={false}
                onSetCreatingChannel={noop}
                onDeleteTag={noop}
                onRenameTag={noop}
                onCreateChannel={noop}
              />
            </div>
          </Row>

          <RenameBlockDialog
            open={open === "rename"}
            currentSlug="popup-1"
            onOpenChange={openChange("rename")}
            onRename={noopAsync}
          />
          <MergeCardsDialog
            open={open === "merge"}
            selectedBlocks={BLOCKS}
            onOpenChange={openChange("merge")}
            onConfirm={noopAsync}
          />
          <DeleteSelectedCardsDialog
            open={open === "delete-selected"}
            selectedCount={3}
            onOpenChange={openChange("delete-selected")}
            onConfirm={noop}
          />
          <CreateCollectionDialog
            open={open === "create-collection"}
            onOpenChange={openChange("create-collection")}
            onCreate={noop}
          />
          <DeleteBlockDialog
            open={open === "delete-block"}
            vaultPath={VAULT_PATH}
            plan={DELETE_PLAN}
            error={null}
            onOpenChange={openChange("delete-block")}
            onKeepMedia={noop}
            onDeleteMedia={noop}
          />
          <ImportDialog
            open={open === "import"}
            onClose={() => setOpen(null)}
            onImportComplete={noop}
          />
          <SearchOverlay
            open={open === "search"}
            query={query}
            vaultPath={VAULT_PATH}
            onQueryChange={setQuery}
            onClose={() => setOpen(null)}
            onOpenBlock={noop}
          />
        </div>
      </DndContext>
    </MemoryRouter>
  );
}
