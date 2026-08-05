# Media Asset Actions Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_INLINE_MEDIA_EXTRACTION.md](SPEC_INLINE_MEDIA_EXTRACTION.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_IDENTITY_ROBUSTNESS.md](SPEC_IDENTITY_ROBUSTNESS.md)

## Goal

Unify the behavior of every local media file rendered by Mine. A photo or video
referenced by `frontmatter.file` and a photo embedded in Markdown body are the
same product object for user interaction: a concrete local media asset.

The action target is the media asset itself, not the card or note that happens
to display it.

## Definitions

### Media asset

A `MediaAsset` is a local file inside the active vault, addressed by normalized
vault-relative path.

Valid sources:

- `frontmatter.file`, including canonical `file: "[[name.ext]]"` and legacy
  `file: name.ext`;
- body embeds, including canonical `![[name.ext]]` and legacy local
  `![alt](name.ext)`;
- resolved attachment paths found through the backend media resolver.

Not media assets:

- remote `http://` or `https://` images;
- generated thumbnails, preview tiles, stitched preview manifests, micro
  previews, and other derived artifacts;
- the `.md` card/note file;
- card-level preview chrome.

### Source context

The same file can be rendered from different contexts:

```ts
type MediaAssetSourceContext = {
  sourceSlug: string;
  referenceKind: "frontmatter_file" | "body_embed";
  bodyOffset?: number;
};
```

The context explains where the user saw the media. It must not change the action
target. Actions still operate on the local media file.

### Materialized media card

Some actions need a card-level object because collections attach to cards, not
raw files. A materialized media card is a normal `.md` file with empty body and
canonical `file: "[[media-ref]]"` frontmatter.

Materialization is a bridge from file-level interaction to collection
membership. It does not make the source article/card the action target.

## Product Invariants

1. Media actions never rename, delete, or connect the visible source card as a
   side effect.
2. `Create Element` and image drag always create a new standalone media card for
   the selected media asset. Choosing `Everything` creates it without channel
   membership; choosing a channel writes that channel to the new card.
3. `Rename Media` renames the physical media file and rewrites references to that
   media file, but it does not rename any `.md` file, title, H1, URL, or source
   note.
4. `Remove from Element` removes only this media reference from the current card.
   The media file and all other cards/notes remain unchanged.
5. `Delete` deletes only the physical media file and removes parseable
   references to that file from every card/note that used it. Cards and notes
   remain in the vault.
6. `Reveal in Finder`, `Copy Path`, and `Copy Media` all resolve and act on the
   media file, not the `.md` file.
7. The feature is local-media only. Remote media has no media-asset actions in
   this contract.
8. Video has hover actions but no drag-to-sidebar behavior.

## Surface Contract

Every rendered local media asset must be wrapped by the same media-asset
interaction boundary.

Included surfaces:

- primary media in a media-card Detail view;
- local images embedded in article/channel Markdown body;
- local videos embedded in article/channel Markdown body;
- local video shown as primary media in a media-card Detail view;
- any future full-fidelity media renderer that displays an original local vault
  file.

Excluded surfaces:

- feed card hover menu, because it is card-level chrome;
- sidebar micro previews, because they are derived thumbnails and may not map to
  one exact source asset;
- Related Notes hover preview chrome, except for media rendered inside the
  opened preview if that preview later becomes interactive;
- remote images and iframes that do not resolve to a local vault file.

If a renderer cannot produce a valid `MediaAssetRef`, it must not show
media-asset controls.

## MediaAssetRef

Frontend and backend commands pass one normalized media reference:

```ts
type MediaAssetKind = "image" | "video" | "file";

type MediaAssetRef = {
  mediaRef: string; // vault-relative, NFC-normalized filesystem path
  mediaKind: MediaAssetKind;
  sourceSlug: string;
  referenceKind: "frontmatter_file" | "body_embed";
  bodyOffset?: number;
};
```

Validation rules:

1. `mediaRef` must be relative to the vault root.
2. Absolute paths, URL strings, empty paths, and `..` traversal are rejected.
3. The canonical resolved path must stay inside the vault root after symlink and
   filesystem normalization.
4. `mediaKind` is derived from the resolved extension and backend media
   resolver, not from legacy `type`.
5. Commands that read, reveal, copy, rename, or delete the file require the file
   to exist at command start. If it is missing, the command returns a typed
   `media_not_found` error and asks the UI to refresh.

## Hover UI

Hovering a local media asset shows one standard overflow trigger in the top
right corner of that media rectangle.

Trigger:

- `Button variant="default" size="icon"`;
- `MoreHorizontal` icon, `size-4`;
- positioned `absolute right-2 top-2`;
- opaque `bg-component-fill` background;
- hover outline from the design-system button variant;
- visible while the media is hovered, focused, or its menu is open.

The media-asset menu is an overflow menu under the ellipsis trigger. It is not
three visible buttons on the media surface.

Menu items:

1. `Create Element` — submenu picker for `Everything` plus channels.
2. `Reveal in Finder`.
3. `Copy Path`.
4. `Copy Media`.
5. `Rename Media...`.
6. `Remove from Element`.
7. `Delete`.

The menu must not include card-level actions such as `Source`, `Remove from
collection`, card rename, or card delete.

Icon policy matches the main card overflow menu: only `Create Element` renders an
icon (`Plus`). `Reveal in Finder`, `Copy Path`, `Copy Media`, `Rename Media...`,
`Remove from Element` and `Delete` keep the same leading icon slot empty so labels
align without adding decorative per-command icons.

`Create Element` submenu height follows the global searchable floating-menu
contract: fixed search header, shared `QuantizedMenuScrollArea` for the channel
rows, `default` 32px row token, and no local `max-height` value.

Video controls remain usable. The media-asset trigger occupies only the top
right corner and does not place a full-surface overlay over the video.

Image click contract:

- left click on a local image opens the fullscreen preview;
- dragging the same image still works: the two are told apart by the shared
  `PointerSensor` activation distance of 8px, so a press that does not move is a
  click and a press that moves is a drag. There is no separate drag handle — a
  handle would be a small target for a gesture that already has a reliable
  discriminator;
- because of this the image surface must not suppress `mousedown`: doing so
  would also suppress the click. Native HTML `dragstart` stays suppressed, since
  dragging belongs to dnd-kit;
- the resting cursor is `zoom-in` (the click is the primary gesture); `grabbing`
  appears only while a drag is actually in progress;
- the top-right media controls keep the standard `Expand` icon button for
  fullscreen image preview;
- both entry points pass every image of the card, in reading order, so the
  viewer can step through them. The set is read from the rendered card: the body
  is Markdown turned into elements, so document order is reading order and no
  separate index can be more authoritative than what the reader sees;
- inside the viewer `ArrowLeft` / `ArrowRight` move between those images and
  wrap at both ends; zoom and pan reset on each step, and `Copy Media` copies
  whatever is on screen rather than the image the viewer was opened with;
- the arrows are claimed only while the viewer is open and the card holds more
  than one image, so card-to-card navigation on the same keys keeps working;
- fullscreen image preview is an app-level overlay, not a nested `Detail`
  dialog and not a Radix portal;
- the overlay is fixed to `top: 32px; bottom: 0`, covers the body and bottom
  action bar with a readable secondary canvas scrim, and leaves the app top bar
  outside the overlay and interactive;
- the secondary canvas keeps the underlying page readable as context while
  making it non-interactive and lower-priority: `background: rgb(0 0 0 / 0.28)`;
- the overlay must not use `backdrop-filter` or blur, because blur destroys the
  semantic readability of the secondary canvas;
- the opened card top bar is covered by the overlay because it belongs to the
  body/detail working area, not to the app shell;
- the viewer does not show a standalone top-right close button;
- viewer controls live in a bottom floating island that uses the same compact
  floating chrome as the opened-card floating top bar;
- the bottom island contains zoom out, current zoom label, zoom in, Copy Media,
  and Close controls;
- clicking outside the sharp foreground image closes the preview, while clicking
  the image toggles zoom between 100% and 150%;
- plus/minus buttons adjust preview scale in `0.2` increments; wheel/trackpad
  input uses `0.0024` exponential sensitivity per delta unit;
- wheel/trackpad zoom and image-click zoom are anchored at the current cursor
  position, so the point under the cursor stays visually stable while scaling;
- pointer drag on the foreground image pans the preview image; it must not
  adjust preview scale and must not show a vertical resize cursor;
- pan is bounded: drag must never move the image fully off screen; at least a
  `48px` visible edge remains on each axis where the image can otherwise leave
  the stage;
- continuous zoom updates the image transform through a DOM ref and
  `requestAnimationFrame`, not React state on every wheel/pointer event; React
  state may update only low-frequency UI such as the numeric zoom label;
- the bottom island appears on pointer movement and fades out after 3 seconds
  of inactivity;
- right click on a local image opens the same media-asset overflow menu as the
  ellipsis trigger;
- this image click contract does not apply to video, because video clicks belong
  to playback controls.

## User Flows

### Create Element from primary media

1. User opens a media card whose primary file is `photo.jpg`.
2. User hovers the image and opens `...`.
3. User selects `Create Element`.
4. User picks `Everything` or a channel from the plain list. Rows do not contain
   separate per-row action buttons.
5. Backend creates a new standalone media card for `photo.jpg`.
6. If the user picked a channel, backend writes that channel to the new card's
   `Mine Collections`; if the user picked `Everything`, the new card has no
   collection membership.
7. The menu closes after the selection.
8. The currently open card is not otherwise renamed, deleted, or rewritten.

Even if the current card already points to `photo.jpg`, `Create Element` still
creates a new card. Reuse is not part of the contract.

### Create Element from inline image

1. User opens an article containing `![[photo.jpg]]`.
2. User hovers that exact inline image and opens `...`.
3. User selects `Create Element` and picks `Everything` or a channel.
4. Backend creates a new standalone media card for `photo.jpg`.
5. The source article stays open and unchanged.

### Drag image to sidebar

1. User drags any local image asset.
2. User drops it on a sidebar collection.
3. Frontend routes `type: "media_asset"` to the media materialization path.
4. Backend creates a new standalone media card and connects it to the target
   collection.
5. The source card/article is not connected to the collection.

Video is excluded from drag. Native browser image drag is disabled so Mine owns
the drag payload and can distinguish media drag from card drag.

### Reveal in Finder

1. User chooses `Reveal in Finder` from a media menu.
2. Backend/frontend resolves the media file path.
3. Finder reveals the media file itself.

It must not reveal `<sourceSlug>.md`.

### Copy Path

1. User chooses `Copy Path`.
2. Clipboard receives the absolute filesystem path to the media file.

It must not copy the Markdown note path, wikilink syntax, or card slug.

### Copy Media

1. User chooses `Copy Media`.
2. Clipboard receives the media object itself.

Expected platform behavior:

- images: native image data, so pasting into image-aware apps pastes the image;
- video and other local files: native file URL / file promise when supported by
  macOS pasteboard.

`Copy Media` is distinct from `Copy Path`; it must not degrade to copying a
plain string path unless the UI explicitly reports that native media copy is
unsupported.

### Rename media

1. User chooses `Rename Media...` from a media menu.
2. Dialog edits the media filename stem; extension is preserved.
3. Backend renames the physical media file.
4. Backend rewrites all parseable references to the old media ref:
   - `frontmatter.file`;
   - body wikilinks;
   - legacy local markdown image URLs.
5. Backend refreshes index rows, media dimensions, preview manifests, and
   affected derived thumbnails.
6. Card filenames, titles, H1s, source URLs, and collection membership stay
   unchanged.

Conflicts are explicit errors. The command must not silently suffix, overwrite,
or rewrite the user's requested name without confirmation.

Media-action scans must use the same Obsidian-compatible Markdown read path as
indexing:

- Markdown files without `type` are valid scan inputs and must not block
  `prepare_delete_media_asset`, `delete_media_asset`, or `rename_media_asset`.
- Unrelated Markdown files must be ignored without rewriting.
- Only files with matched media references are rewritten.

### Delete media

1. User chooses `Delete` from a media menu.
2. UI calls `prepare_delete_media_asset(media_ref)`.
3. UI confirmation shows:
   - thumbnail/preview of the exact media file that will be deleted;
   - `Connected elements` subsection title above the reference list;
   - every card/note that currently references that file, rendered with the
     same clickable related-note row component used in the Detail right sidebar.
     Rows keep the same thumbnail, hover preview, and click-to-open behavior.
     Long card titles must stay inside the dialog width: the dialog body,
     scroll area and related-note list are `min-w-0`, and row labels truncate
     instead of widening the confirmation surface.
   - reference kind is not shown as custom text in the primary confirmation UI.
   - the list shows up to 5 connected-card rows without scrolling; additional
     rows scroll inside the list area.
4. Backend removes all parseable references to that file:
   - `frontmatter.file`;
   - matching `thumbnail`;
   - body wikilink embeds;
   - legacy local Markdown image URLs.
5. Backend deletes the physical media file.
6. Backend refreshes affected index rows and thumbnails/previews.
7. Affected cards/notes remain in the app; they no longer intentionally contain
   stale references to the deleted file.

### Remove media from card

1. User chooses `Remove from Element` from a media menu.
2. UI confirms that only the current card reference will be removed.
3. Backend removes `frontmatter.file`/matching `thumbnail` for primary media,
   or removes matching inline body embeds for body media.
4. Backend does not delete the media file.
5. Backend does not rewrite other cards/notes that reference the same file.

### Missing media

If the file disappears before the action:

- hover controls may still render from stale indexed state until refresh;
- the next command must fail with `media_not_found`;
- UI refreshes the affected block/media surface;
- no fallback card-level action is attempted.

## Backend Commands

The existing card commands remain card-level and must not be reused for
media-level mutations.

Required command shape:

```rust
#[tauri::command(rename_all = "snake_case")]
async fn create_media_asset_card(
    state: State<'_, AppState>,
    media_ref: String,
    target_collection_ref: String,
    source_slug: Option<String>,
) -> Result<IndexedBlock, MediaAssetActionError>;

#[tauri::command(rename_all = "snake_case")]
async fn rename_media_asset(
    state: State<'_, AppState>,
    media_ref: String,
    new_stem: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError>;

#[tauri::command(rename_all = "snake_case")]
fn prepare_delete_media_asset(
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<DeleteMediaAssetPlan, MediaAssetActionError>;

#[tauri::command(rename_all = "snake_case")]
async fn delete_media_asset(
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError>;

#[tauri::command(rename_all = "snake_case")]
fn remove_media_asset_from_card(
    state: State<'_, AppState>,
    media_ref: String,
    source_slug: String,
    reference_kind: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError>;

#[tauri::command(rename_all = "snake_case")]
fn copy_media_asset_to_clipboard(
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<(), MediaAssetActionError>;
```

`Reveal in Finder` and `Copy Path` may use existing frontend utilities only if
they first resolve the media path from `mediaRef`. They must never derive a path
from block slug.

### Materialization

`create_media_asset_card` and drag-to-sidebar share the same materialization
path.

Algorithm:

1. Validate and resolve `media_ref`.
2. Normalize `target_collection_ref`. Empty value means `Everything` and is
   valid only for this command.
3. Always create a new empty-body media card:

   ```markdown
   ---
   type: image
   file: "[[photo.jpg]]"
   Mine Collections:
     - "[[Target Collection]]"
   Mine Related Notes:
     - "[[Source Article]]"
   Mine Source Media: photo.jpg
   saved_at: 2026-05-09T00:00:00Z
   source: media-asset-action
   ---
   ```

4. If `target_collection_ref` is empty, write no `Mine Collections` entries.
5. Generate/refresh thumbnail from the media file.
6. Index affected blocks and emit the same refresh events as normal block
   creation/update.

`Mine Related Notes` and `Mine Source Media` are written only when the source
context is known and useful. They are provenance, not identity.

### Error type

```rust
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MediaAssetActionError {
    NoVault,
    InvalidMediaRef { reason: String },
    MediaNotFound { media_ref: String },
    UnsupportedMediaKind { media_ref: String },
    NameTaken { target: String },
    InvalidFilename { reason: String },
    ClipboardUnsupported { media_ref: String },
    Internal { message: String },
}
```

## Frontend Contract

### Shared renderer wrapper

Use one wrapper for all local media surfaces:

```ts
type MediaAssetActionFrameProps = {
  asset: MediaAssetRef;
  canDrag: boolean;
  children: ReactNode;
};
```

Rules:

1. The wrapper owns the hover trigger and menu.
2. The wrapper does not know about card-level actions.
3. Image renderers set `canDrag=true`; video renderers set `canDrag=false`.
4. The wrapper keeps native media playback controls accessible.
5. Remote media renderers do not instantiate the wrapper.

### Drag payload

```ts
type MediaAssetDragPayload = {
  type: "media_asset";
  asset: MediaAssetRef & { mediaKind: "image" };
};
```

Drop routing:

| Active payload | Drop target | Behavior |
|---|---|---|
| `block` | `collection:<ref>` | Existing card connect path |
| `media_asset` | `collection:<ref>` | `create_media_asset_card` |
| `media_asset` | anything else | No-op |
| `collection:<ref>` | `collection:<ref>` | Existing reorder path |

`media_asset` must never fall through to the card connect path.

## Testing Plan

### Rust tests

| Area | Scenarios |
|---|---|
| media ref resolver | rejects absolute/remote/traversal, normalizes NFC, resolves frontmatter/body refs |
| create card | creates a new media card from primary/inline image, optional channel membership, no source card membership change |
| rename | renames file, rewrites frontmatter/body references, preserves card slugs/titles/H1s, rejects conflict |
| delete | prepares referenced-card plan, deletes file, keeps `.md`, removes frontmatter/body refs, invalidates stale thumbnails |
| copy | image copy success path, unsupported media kind error/fallback |

### Frontend tests

| Area | Scenarios |
|---|---|
| Detail primary image | shows media menu, menu target is media asset |
| Article inline image | same menu and same commands as primary media |
| Video | shows menu, no drag payload |
| Drag | image drag creates `media_asset`, sidebar drop calls media command |
| Menu | contains Create Element, Reveal in Finder, Copy Path, Copy Media, Rename Media, Remove from Element, Delete only |
| Icon economy | only Create Element renders an icon; remaining command rows keep empty icon slots |
| Regression | card hover menu remains card-level and still uses card actions |

### Manual QA

1. Open a media card with `file: "[[photo.jpg]]"` and verify menu/actions act on
   `photo.jpg`.
2. Open an article with `![[photo.jpg]]` and verify the same menu/actions.
3. Drag primary image to sidebar collection and verify a media card, not the
   source article, is connected.
4. Drag inline image to sidebar collection and verify the source article is
   unchanged.
5. Rename inline image and verify both the source article embed and any
   media-card `file` field point to the new filename.
6. Delete media and verify `.md` files remain, parseable references to the media
   file are removed, and affected previews refresh.
7. Reveal/copy path and verify they target the media file, not `.md`.
8. Copy image and paste into an image-aware app.
9. Hover local video and verify menu works while native video controls remain
   usable.

## Acceptance Criteria

- [ ] Frontmatter media and inline media share the same hover menu behavior.
- [ ] The hover trigger is the standard icon-only default Button under an
      ellipsis menu.
- [ ] Menu actions target only the media file.
- [ ] Only `Create Element` renders an icon in the media menu; other rows reserve
      an empty leading slot.
- [ ] Create Element always creates a new standalone media card and optionally
      connects that card.
- [ ] Create Element submenu uses the shared quantized menu list height and never
      clips a partial channel row.
- [ ] Image drag to sidebar uses the same media materialization path.
- [ ] Video has actions but no drag.
- [ ] Rename media does not rename any card.
- [ ] Delete media does not delete any card and removes parseable references to
      the deleted file.
- [ ] Reveal in Finder and Copy Path resolve the media file.
- [ ] Copy Media copies the media object, not the path string.
- [ ] Remote media does not show local media actions.
