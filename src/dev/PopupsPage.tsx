// Every modal window of the app open at once, for a look at their design
// (DESIGN_SYSTEM.md, «Окна»).
//
// The page lays out one frame per window; each frame loads this page with
// `?popup=<id>` and shows that one window open over an empty page, as the app
// shows it. The windows are the production components with props written
// here; their handlers do nothing. The two calls a window makes on opening
// get fixed answers.

import { useState } from "react";
import { DndContext } from "@dnd-kit/core";
import { MemoryRouter } from "react-router";
import { mockIPC } from "@tauri-apps/api/mocks";
import { CreateCollectionDialog } from "@/components/CreateCollectionDialog";
import { DeleteBlockDialog } from "@/components/DeleteBlockDialog";
import { DeleteSelectedCardsDialog } from "@/components/DeleteSelectedCardsDialog";
import {
  DeleteMediaAssetDialog,
  RemoveMediaAssetFromCardDialog,
  RenameMediaAssetDialog,
} from "@/components/Detail";
import { MergeCardsDialog } from "@/components/MergeCardsDialog";
import { RenameBlockDialog } from "@/components/RenameBlockDialog";
import { DeleteCollectionDialog } from "@/components/Sidebar";
import { CreateCollectionNameDialog } from "@/components/TopCollectionSwitcher";
import { KEEP_ALL, VaultConflictsDialog } from "@/components/VaultConflictsNotice";
import { RemoveSpaceDialog } from "@/components/VaultSwitcher";
import { DeleteSourceVideoDialog } from "@/components/YoutubeSourcePlayer";
import { DeleteOrphansDialog } from "@/settings/OrphansSection";
import type {
  DeleteBlockPlan,
  DeleteBlocksPlan,
  DeleteMediaAssetPlan,
  LightBlock,
  MediaAssetRef,
  VaultConflict,
} from "@/types";

const VAULT_PATH = "/Users/me/References";

function noop() {
  return undefined;
}

async function noopAsync() {
  return undefined;
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

const DELETE_PLAN: DeleteBlockPlan = {
  slug: "popup-1",
  markdown_file: "Cards/popup-1.md",
  unused_media: [],
  shared_media: [],
};

const DELETE_PLAN_WITH_MEDIA: DeleteBlockPlan = {
  slug: "popup-1",
  markdown_file: "Cards/popup-1.md",
  unused_media: [
    { path: "Media/tokyo-sunset.jpg", file_name: "tokyo-sunset.jpg", kind: "image", referenced_by: [] },
    { path: "Media/interview.mp4", file_name: "interview.mp4", kind: "video", referenced_by: [] },
    { path: "Media/notes.pdf", file_name: "notes.pdf", kind: "document", referenced_by: [] },
  ],
  shared_media: [],
};

const DELETE_SELECTION_PLAN: DeleteBlocksPlan = {
  slugs: ["popup-1", "popup-2", "popup-3"],
  markdown_files: ["popup-1.md", "popup-2.md", "popup-3.md"],
  unused_media: [],
  shared_media: [
    { path: "Media/cover.jpg", file_name: "cover.jpg", kind: "image", referenced_by: ["popup-4"] },
  ],
};

const DELETE_SELECTION_PLAN_WITH_MEDIA: DeleteBlocksPlan = {
  ...DELETE_SELECTION_PLAN,
  unused_media: [
    { path: "Media/tokyo-sunset.jpg", file_name: "tokyo-sunset.jpg", kind: "image", referenced_by: ["popup-1", "popup-2"] },
    { path: "Media/interview.mp4", file_name: "interview.mp4", kind: "video", referenced_by: ["popup-3"] },
  ],
};

const MEDIA_ASSET: MediaAssetRef = {
  media_ref: "Media/tokyo-sunset.jpg",
  media_kind: "image",
  source_slug: "popup-1",
  reference_kind: "frontmatter_file",
};

const MEDIA_PLAN: DeleteMediaAssetPlan = {
  media_ref: "Media/tokyo-sunset.jpg",
  media_kind: "image",
  referenced_by: [
    { slug: "popup-1", title: "Local-first software", display_title: "Local-first software", fallback_label: "Local-first software", card_kind: "article", reference_kinds: ["frontmatter_file"] },
    { slug: "popup-2", title: "CRDTs explained", display_title: "CRDTs explained", fallback_label: "CRDTs explained", card_kind: "article", reference_kinds: ["body_embed"] },
  ],
  canvases: [],
};

// Three conflicts with fixed versions: one at rest, one being resolved, one
// refused. The version in the folder never names its device (live check of
// 11.10.2026, SPEC_ICLOUD_CONFLICTS.md).
const CONFLICT_BEING_KEPT = "Notes/A very long note name that does not fit on one line of the window.md";
const CONFLICT_REFUSED = "Journal/20.02.2026.md";

const CONFLICTS: VaultConflict[] = [
  {
    path: "Cards/Local-first software.md",
    name: "Local-first software",
    detected_at: "2026-10-11T09:00:00Z",
    current: { token: null, modified: "2026-10-10T15:00:00Z", device: null },
    versions: [{ token: "popup-a", modified: "2026-10-10T12:54:13Z", device: "Anna’s MacBook Pro" }],
    unanswered: false,
  },
  {
    path: CONFLICT_BEING_KEPT,
    name: "A very long note name that does not fit on one line of the window",
    detected_at: "2026-10-10T18:30:00Z",
    current: { token: null, modified: "2026-01-26T11:43:53Z", device: null },
    versions: [
      { token: "popup-b", modified: "2025-12-31T14:01:00Z", device: "MacBook Pro" },
      { token: "popup-c", modified: "2025-12-30T08:20:00Z", device: null },
    ],
    unanswered: false,
  },
  {
    path: CONFLICT_REFUSED,
    name: "20.02.2026",
    detected_at: "2026-10-09T08:00:00Z",
    current: { token: null, modified: "2026-02-20T15:00:00Z", device: null },
    versions: [{ token: "popup-d", modified: "2026-02-20T09:54:18Z", device: "iPhone" }],
    unanswered: false,
  },
];

const CONFLICTS_BUSY = { [CONFLICT_BEING_KEPT]: KEEP_ALL };

const CONFLICTS_ERRORS = {
  [CONFLICT_REFUSED]: "“20.02.2026” changed outside Mine; nothing was changed. Try again.",
};

// Delete media file asks which elements use the file, and each row for its
// element, as it opens.
mockIPC((command) => {
  if (command === "prepare_delete_media_asset") return MEDIA_PLAN;
  return null;
});

// Files of the space become the dev server's sample pictures, so the
// windows that show media show a picture rather than an empty frame.
const tauriWindow = window as unknown as {
  __TAURI_INTERNALS__: { convertFileSrc?: (filePath: string, protocol?: string) => string };
};
tauriWindow.__TAURI_INTERNALS__.convertFileSrc = (filePath) => {
  let hash = 0;
  for (const char of filePath) hash = (hash * 31 + char.charCodeAt(0)) % 6;
  return `/feed-scroll-audit/audit-${hash}.svg`;
};

const POPUPS = [
  { id: "rename", title: "Rename file (RenameBlockDialog)" },
  { id: "rename-media", title: "Rename media (Detail, RenameMediaAssetDialog)" },
  { id: "create-collection", title: "New collection (CreateCollectionDialog)" },
  { id: "create-collection-switcher", title: "New collection from the path (TopCollectionSwitcher)" },
  { id: "merge", title: "Merge (MergeCardsDialog)" },
  { id: "conflicts", title: "iCloud conflicts (VaultConflictsDialog)" },
  { id: "delete-element", title: "Delete element (DeleteBlockDialog)" },
  { id: "delete-element-media", title: "Delete element with its media (DeleteBlockDialog)" },
  { id: "delete-selected", title: "Delete selected (DeleteSelectedCardsDialog, one window for every entry)" },
  { id: "delete-selected-media", title: "Delete selected with their media (DeleteSelectedCardsDialog)" },
  { id: "delete-selected-deleting", title: "Delete selected while the batch runs (DeleteSelectedCardsDialog)" },
  { id: "delete-collection", title: "Delete collection (Sidebar, DeleteCollectionDialog)" },
  { id: "remove-space", title: "Remove space (VaultSwitcher, RemoveSpaceDialog)" },
  { id: "delete-embed", title: "Delete embed (YoutubeSourcePlayer)" },
  { id: "remove-media", title: "Remove media from element (Detail)" },
  { id: "delete-media", title: "Delete media file (Detail)" },
  { id: "delete-orphans", title: "Delete orphan files (Settings, OrphansSection)" },
] as const;

type PopupId = (typeof POPUPS)[number]["id"];

function OnePopup({ id }: { id: PopupId }) {
  const [collectionName, setCollectionName] = useState("Typography");
  return (
    <MemoryRouter initialEntries={["/"]}>
      <DndContext>
        <div className="min-h-screen bg-background" />
        {id === "rename" && (
          <RenameBlockDialog open currentSlug="Local-first software" onOpenChange={noop} onRename={noopAsync} />
        )}
        {id === "rename-media" && (
          <RenameMediaAssetDialog asset={MEDIA_ASSET} open onOpenChange={noop} onRename={noopAsync} />
        )}
        {id === "create-collection" && (
          <CreateCollectionDialog open onOpenChange={noop} onCreate={noop} />
        )}
        {id === "create-collection-switcher" && (
          <CreateCollectionNameDialog
            open
            name={collectionName}
            error={null}
            creating={false}
            onOpenChange={noop}
            onNameChange={setCollectionName}
            onSubmit={noop}
          />
        )}
        {id === "merge" && (
          <MergeCardsDialog open selectedBlocks={BLOCKS} onOpenChange={noop} onConfirm={noopAsync} />
        )}
        {id === "conflicts" && (
          <VaultConflictsDialog
            open
            conflicts={CONFLICTS}
            busy={CONFLICTS_BUSY}
            errors={CONFLICTS_ERRORS}
            onOpenChange={noop}
            onKeep={noop}
            onKeepAll={noop}
          />
        )}
        {id === "delete-element" && (
          <DeleteBlockDialog
            open
            vaultPath={VAULT_PATH}
            plan={DELETE_PLAN}
            error={null}
            onOpenChange={noop}
            onKeepMedia={noop}
            onDeleteMedia={noop}
          />
        )}
        {id === "delete-element-media" && (
          <DeleteBlockDialog
            open
            vaultPath={VAULT_PATH}
            plan={DELETE_PLAN_WITH_MEDIA}
            error={null}
            onOpenChange={noop}
            onKeepMedia={noop}
            onDeleteMedia={noop}
          />
        )}
        {id === "delete-selected" && (
          <DeleteSelectedCardsDialog
            open
            vaultPath={VAULT_PATH}
            plan={DELETE_SELECTION_PLAN}
            error={null}
            pending={null}
            deleteError={null}
            onOpenChange={noop}
            onKeepMedia={noop}
            onDelete={noop}
          />
        )}
        {id === "delete-selected-media" && (
          <DeleteSelectedCardsDialog
            open
            vaultPath={VAULT_PATH}
            plan={DELETE_SELECTION_PLAN_WITH_MEDIA}
            error={null}
            pending={null}
            deleteError={null}
            onOpenChange={noop}
            onKeepMedia={noop}
            onDelete={noop}
          />
        )}
        {id === "delete-selected-deleting" && (
          <DeleteSelectedCardsDialog
            open
            vaultPath={VAULT_PATH}
            plan={DELETE_SELECTION_PLAN_WITH_MEDIA}
            error={null}
            pending="delete"
            deleteError={null}
            onOpenChange={noop}
            onKeepMedia={noop}
            onDelete={noop}
          />
        )}
        {id === "delete-collection" && (
          <DeleteCollectionDialog open label="Typography" onOpenChange={noop} onConfirm={noop} />
        )}
        {id === "remove-space" && (
          <RemoveSpaceDialog path={VAULT_PATH} onCancel={noop} onConfirm={noop} />
        )}
        {id === "delete-embed" && (
          <DeleteSourceVideoDialog open onOpenChange={noop} onDelete={noopAsync} />
        )}
        {id === "remove-media" && (
          <RemoveMediaAssetFromCardDialog asset={MEDIA_ASSET} open onOpenChange={noop} onRemove={noopAsync} />
        )}
        {id === "delete-media" && (
          <DeleteMediaAssetDialog
            asset={MEDIA_ASSET}
            vaultPath={VAULT_PATH}
            open
            onOpenChange={noop}
            onDelete={noopAsync}
            onOpenRelatedNote={noop}
          />
        )}
        {id === "delete-orphans" && (
          <DeleteOrphansDialog open count={4} onOpenChange={noop} onConfirm={noop} />
        )}
      </DndContext>
    </MemoryRouter>
  );
}

export function PopupsPage() {
  const only = new URLSearchParams(window.location.search).get("popup");
  const single = POPUPS.find((popup) => popup.id === only);
  if (single) return <OnePopup id={single.id} />;

  return (
    // The app locks the document's scroll, so the page scrolls itself; the
    // frames take no pointer, so the wheel over them scrolls the page.
    <div className="h-screen overflow-y-auto bg-background px-6 py-6 text-foreground">
      <h1 className="mb-4 text-lg font-semibold">Windows</h1>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(640px,1fr))] gap-6">
        {POPUPS.map((popup) => (
          <figure key={popup.id} className="flex flex-col gap-2">
            <figcaption className="text-sm text-muted-foreground">{popup.title}</figcaption>
            <iframe
              title={popup.title}
              src={`/__popups?popup=${popup.id}`}
              className="pointer-events-none h-[560px] w-full border border-border"
            />
          </figure>
        ))}
      </div>
    </div>
  );
}
