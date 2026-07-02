# Card Merge Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

Status: implemented.

## Goal

Add a batch `Merge` action for Grid group selection. The user can select two
or more cards, choose the order, and replace them with one new Markdown card
that preserves all selected content, media references, collection membership
and note relationships.

The operation is destructive to the source card `.md` files but non-destructive
to media files. Merge must feel like a local Markdown operation, not like an
opaque database mutation.

## Product Contract

### User Scenario

1. User enters Grid group selection and selects two or more cards.
2. The bottom batch action island shows `Merge` between collection actions and
   `Delete`.
3. User presses `Merge`.
4. Mine opens a modal dialog with the selected cards in their current merge
   order.
5. User can drag rows by a handle to reorder the cards.
6. User confirms `Merge`.
7. Mine creates one new card, removes the original selected cards, clears
   group selection and keeps the user near the same Grid viewport.

### Action Availability

`Merge` is available only when `selectedSlugs.size >= 2`.

Surfaces:

| Surface | Contract |
|---|---|
| Bottom batch action island | Shows `Merge` between `Connect`/`Disconnect` and `Delete`. |
| Focused-card batch `Cmd+K` menu | Shows the same `Merge` command when at least two cards are selected. |
| Single-card menu | Does not show `Merge`. One card is not a merge set. |
| Detail | Out of scope. Merge is a Grid group-selection action. |

Bottom island order:

```text
<count>  Connect  Disconnect?  Merge  Delete  X
```

Focused-card batch menu order:

```text
<count header>
Connect
Disconnect?   // only inside a concrete collection route
Merge         // only when selected count >= 2
Delete
```

Icon policy follows the current batch menu contract:

- `Connect` keeps the `Plus` icon;
- `Disconnect`, `Merge` and `Delete` keep empty leading slots for text
  alignment and do not render decorative icons;
- destructive color is used only for `Delete`.

## Merge Dialog

### Copy

All visible text is English.

Recommended copy:

| Element | Text |
|---|---|
| Title | `Merge 2 cards`, `Merge 36 cards` |
| Helper | `Drag cards to set the merge order.` |
| Cancel button | `Cancel` |
| Confirm button | `Merge` |

The helper is intentionally instructional but short. It explains why the list
is reorderable without adding a second heading.

### Layout

The dialog uses the existing application dialog shell and animation. It must
not introduce a new modal style.

Structure:

1. Header:
   - title `Merge N cards`;
   - helper text.
2. Reorderable card list.
3. Footer with `Cancel` and `Merge`.

The selected-card list scrolls when it does not fit. Header and footer stay
fixed. Only the repeated row list scrolls.

### Card Row Reuse

Rows must reuse the same visual component as `RELATED NOTES` in the Detail
right rail: compact shell, `MicroPreviewThumbnail`, thumbnail on the left, and
filename/display label on the right.

Implementation requirement:

- extract the current related-note row visual into a shared component, for
  example `CardReferenceRow`;
- use it from both `RelatedNotesSection` and `MergeCardsDialog`;
- do not duplicate row classes or rebuild a lookalike row in the merge dialog.

Merge-specific additions:

- a drag handle is placed to the left of the reused row content;
- the handle is the only drag activation surface;
- dragging the row must not open a card and must not conflict with dialog
  scroll;
- the row still truncates long titles exactly like the Detail related-note row.

### Reordering

The initial order is deterministic:

1. current Grid visual order for selected cards;
2. if opened from keyboard batch menu, the focused card may be moved to the
   first position only if it is already the first selected visual card under
   Grid order. Keyboard focus itself must not secretly reorder the merge set.

The dialog order is the only source of truth for backend merge order. The
backend must not reorder `ordered_slugs` by slug, id, saved date or current
collection order.

Keyboard support:

- `Escape` closes the dialog without merging;
- `Tab` follows normal dialog focus order;
- sortable keyboard reordering may use the existing dnd-kit keyboard sensor if
  already available in the project, but pointer reordering is the required
  first-class path.

## Output Markdown Contract

Merge creates one new `article` card. It does not create a media card even if
all selected cards are media cards, because the result has a multi-section body.

### New Frontmatter

The new card frontmatter is canonical Mine Markdown:

```markdown
---
type: article
url: https://example.com/source
author: Author Name
Mine Collections:
  - "[[Collection A]]"
  - "[[Collection B]]"
Mine Related Notes:
  - "[[Related Note]]"
saved_at: 2026-05-27T12:00:00Z
source: card-merge
---
```

Rules:

| Field | Rule |
|---|---|
| `type` | Always `article`. |
| `url` | First safe `http://` or `https://` `url` in merge order. Empty, relative or non-openable values are ignored so the merge can fall through to the next card. |
| `author` | First non-empty `author` in merge order. |
| `description` | First non-empty `description` in merge order, only if present. |
| `Mine Collections` | Ordered union of every selected source card's `Mine Collections`, deduped by collection ref. |
| `Mine Related Notes` | Ordered union of every selected source card's related-note refs, after relationship rewrite rules below. |
| `saved_at` | Merge time. |
| `source` | Literal `card-merge`. |
| `file` | Omitted. Media references live in the body sections. |
| `thumbnail` | Omitted on write; derived preview pipeline regenerates the new card preview. |
| `title` | Not synthesized. Legacy `title` is not copied into new writes. |
| `width` / `height` | Omitted. A merged article is not one primary media asset. |

`source: card-merge` records operation provenance. It must not be confused with
the user's source URL, which lives in `url`.

### Filename / Slug

The backend generates a readable unique filename.

Seed priority:

1. first selected card display label;
2. first selected card fallback label;
3. `Merged cards`.

Recommended suffix: ` — merged`.

Example:

```text
Braun Design — merged.md
Braun Design — merged (2).md
```

The filename is identity. The merge path must not write a synthetic `title:`
just to control the visible label.

### Body Sections

The body is composed in the user-defined order. Every source card contributes
one section. Sections are separated by a horizontal rule.

Template:

```markdown
<card content>

Source: [example.com](https://example.com/article)
Author: Author Name

---

<next card content>
```

Section rules:

1. Preserve body Markdown bytes as much as possible.
2. Trim only outer blank lines around each section.
3. Keep existing headings, inline media wikilinks, Markdown links and Obsidian
   block ids.
4. Do not rewrite image syntax to another format. Existing canonical
   `![[media.ext]]` stays canonical.
5. Do not add a section heading unless it already exists in the source body.
6. Append `Source:` only when that source card has a safe `http://` or
   `https://` `url`; relative placeholders such as `/` are treated as missing
   source metadata.
7. Append `Author:` only when that source card has `author`.
8. Escape Markdown-special characters in appended author text.
9. If a source section has no body and no renderable media/url fallback, write
   the card display label as plain text so the section is not empty.

### Source Card Content Mapping

| Source card shape | Section content |
|---|---|
| Bodyful article/card | Source body as-is, trimmed at section boundary only. |
| Empty-body media card with `media_file` | `![[<media_file>]]`. |
| Empty-body link card with `url` and no media | Markdown link using display label as text. |
| Empty-body file/video card with `media_file` | `![[<media_file>]]`. |
| Empty-body card with neither media nor url | Display/fallback label as plain text. |

Media-card sections may also append `Source:` and `Author:` if those fields are
present on the source card.

### Example

Input A:

```markdown
---
type: article
url: https://example.com/a
author: Ada
Mine Collections:
  - "[[Research]]"
saved_at: 2026-05-20T10:00:00Z
source: browser-extension
---

# First Article

Text A.
```

Input B:

```markdown
---
type: image
file: "[[diagram.png]]"
Mine Collections:
  - "[[Research]]"
  - "[[Diagrams]]"
saved_at: 2026-05-21T10:00:00Z
source: media-asset-action
---
```

Output:

```markdown
---
type: article
url: https://example.com/a
author: Ada
Mine Collections:
  - "[[Research]]"
  - "[[Diagrams]]"
saved_at: 2026-05-27T12:00:00Z
source: card-merge
---

# First Article

Text A.

Source: [example.com](https://example.com/a)
Author: Ada

---

![[diagram.png]]
```

### Preview Tiles

Merged-карточка — это `article` с multi-section body, поэтому её preview-манифест
(social/article tiles) собирается из **всех** `---`-секций body, а не только из
первой. Card merge склеивает секции через `\n\n---\n\n`, и реальное медиа часто
живёт в поздних секциях; сбор только по первой секции терял бы эти тайлы и их
постеры (`extract_social_preview_tiles`, `src-tauri/src/storage/index.rs`).
`PREVIEW_TILE_LIMIT = 4` действует глобально по всему body, порядок тайлов —
порядок медиа в документе.

## Media Ownership

Merge must never copy, rewrite, rename or delete media files.

Rules:

1. Existing media filenames remain unchanged.
2. Source body media embeds are copied as references into the merged body.
3. Empty-body media cards become body wikilinks to their existing media file.
4. No new media binary is created.
5. No media binary is deleted as part of merge.
6. After merge, media lifecycle belongs to the new merged card and any other
   remaining references in the vault.

This is stricter than delete behavior. Merge removes source `.md` cards, but
it does not perform unused-media cleanup. Deleting media remains an explicit
delete operation.

## Relationship Preservation

Merge is a many-to-one graph operation. It must preserve both outgoing
relationships from selected source cards and incoming relationships from other
notes/cards.

### Outgoing Relationships

The merged card keeps the union of:

1. source cards' `Mine Related Notes` values;
2. source bodies' existing Obsidian wikilinks and Markdown links, because body
   content is copied into the merged body;
3. block-reference fragments such as `[[Source#^block-id]]`.

Rules:

- remove references that point to any selected source slug, because those
  cards are deleted;
- dedupe by normalized target while preserving first occurrence order;
- preserve block-reference fragments and aliases when the target remains
  outside the selected set.

### Incoming Relationships

Any parseable Markdown file outside the selected source set that links to a
selected source slug must be rewritten to the new merged slug.

This includes:

- body wikilinks: `[[Old Card]]`, `[[Old Card|alias]]`,
  `[[Old Card#^block-id]]`;
- frontmatter `Mine Related Notes`;
- frontmatter `Mine Collections` is not rewritten, because selected cards are
  not collection pages.

Many-to-one rewrite rules:

| Old target | New target |
|---|---|
| `[[Old Card]]` | `[[Merged Card]]` |
| `[[Old Card|alias]]` | `[[Merged Card|alias]]` |
| `[[Old Card#^block-id]]` | `[[Merged Card#^block-id]]` |
| `[[Old Card#^block-id|alias]]` | `[[Merged Card#^block-id|alias]]` |

Preserving `#^block-id` is valid because merge copies source body content,
including existing Obsidian block ids, into the merged body.

### Text-Selection Extraction Scenario

When a user previously created an excerpt card from article `A`, that excerpt
stores `Mine Related Notes: [[A#^block-id]]`. If article `A` is later merged
with other selected cards into `M`, the excerpt card must be rewritten to
`[[M#^block-id]]`. This keeps the excerpt visible as a related note of the new
merged card.

This behavior is required. Without it, merge would silently break one of the
core relationship use cases.

## Backend Command Contract

The frontend must not compose merge from independent `createBlock`,
`deleteBlock` and rename calls. Merge is one backend command.

### Tauri Command

```rust
#[tauri::command(rename_all = "snake_case")]
fn merge_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    ordered_slugs: Vec<String>,
) -> Result<MergeBlocksResult, MergeBlocksError>
```

### TypeScript Wrapper

```ts
type MergeBlocksResult = {
  block: IndexedBlock;
  merged_slug: string;
  removed_slugs: string[];
};

function mergeBlocks(orderedSlugs: string[]): Promise<MergeBlocksResult>;
```

### Validation

The backend validates before writing:

1. vault is open;
2. `ordered_slugs.length >= 2`;
3. slugs are unique after normalization;
4. every source `.md` exists;
5. every source block is parseable;
6. no source block is a `channel` collection page;
7. the generated output slug does not collide with an existing `.md`;
8. all media refs copied into the merged body are local safe refs or existing
   remote URLs already present in source Markdown.

### Error Shape

```rust
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MergeBlocksError {
    NoVault,
    TooFewCards,
    DuplicateSlug { slug: String },
    BlockNotFound { slug: String },
    BlockNotMergeable { slug: String, block_type: String },
    InvalidSlug { slug: String, reason: String },
    ReferenceRewriteFailed { path: String, message: String },
    Internal { message: String },
}
```

Errors are recoverable: the dialog stays open, selection stays intact, and the
user can cancel or retry.

## Backend Algorithm

Merge is staged and transaction-like. Because the source of truth is the
filesystem, the command cannot rely only on SQLite transaction semantics.

Algorithm:

1. Read every source `.md` in `ordered_slugs`.
2. Parse every source block and build a pure `MergePlan`.
3. Generate output slug and output Markdown bytes with create-new collision
   protection.
4. Build many-to-one rewrite specs for every parseable non-selected `.md` file
   that references selected source slugs.
5. Suppress watcher paths for the new card, removed source cards and rewritten
   files.
6. Write the new merged `.md` using create-new semantics.
7. Apply external relationship rewrites.
8. Delete selected source `.md` files.
9. Delete only source-card derived artifacts such as stale thumbnails/index
   rows. Do not delete media binaries.
10. Index the new block and every rewritten file.
11. Emit events:
    - `block:added` for the merged block;
    - `block:removed` for each removed source slug;
    - `thumb:updated` for the merged slug after preview generation;
    - refresh events for rewritten related-note targets as needed.
12. Return `MergeBlocksResult`.

Rollback/repair contract:

- If planning fails, no file is written.
- If writing the new file fails, no source file is deleted.
- If a write/delete/index step fails after mutation has started, the backend
  runs best-effort rollback: remove the new merged `.md`, restore original
  rewritten file bytes, restore source `.md` bytes if needed, and repair index
  rows from restored files.
- Source files are deleted only after the new merged file and external rewrites
  have succeeded.
- A later recovery pass may rebuild index/thumbnail state from files; no hidden
  sidecar is required for correctness.

## Frontend Integration

### State Flow

1. `Grid` owns selected slugs and visual order.
2. `App` opens `MergeCardsDialog` with the selected `LightBlock`/`IndexedBlock`
   snapshots needed for row rendering.
3. Dialog owns temporary row order.
4. Confirm calls `mergeBlocks(orderedSlugs)`.
5. On success:
   - close dialog;
   - clear group selection;
   - remove deleted slugs from optimistic block state;
   - insert or refresh the returned merged block through existing App refresh
     path;
   - preserve Grid viewport using the existing delete/replace scroll-anchor
     contract.

### Viewport Preservation

Merge removes multiple cards and inserts one card, so it must use the same
anchor principle as batch delete:

- capture a surviving card near the viewport top before the source block list
  changes;
- after the new layout generation commits, restore that anchor offset;
- if no surviving anchor exists, keep the merged card near the previous
  viewport rather than jumping to the top of the collection;
- stale keyboard focus must not autoscroll over the pending merge anchor.

### Optimistic UI

Do not optimistically delete source cards before the backend confirms success.

Allowed optimistic state:

- disable confirm button while merge is running;
- show a compact progress state inside the dialog;
- keep selected frames visible behind the modal.

Not allowed:

- remove selected cards before command success;
- create a fake merged card in Grid before backend returns the actual slug;
- run N frontend delete calls after create.

## Accessibility

Dialog:

- `role="dialog"` through the shared dialog primitive;
- accessible title `Merge N cards`;
- helper text is associated with the dialog description;
- confirm button has accessible name `Merge`;
- cancel button has accessible name `Cancel`.

Rows:

- drag handle has accessible name `Reorder card`;
- row label is the card display/fallback label;
- rows remain readable and truncatable at narrow dialog widths;
- focus ring follows the existing row/focus design-system contract.

## Out Of Scope

- Merging channels/collection pages.
- Partial merge that keeps original cards.
- Media cleanup during merge.
- Splitting a merged card back into source cards.
- Showing a rich preview of the final Markdown inside the merge dialog.
- Editing section text inside the merge dialog.
- Cross-vault merge.

## Testing Requirements

### Backend Unit Tests

- rejects fewer than two slugs;
- rejects duplicate slugs;
- rejects missing source block;
- rejects `channel` source;
- output frontmatter uses first non-empty `url` and `author`;
- output `Mine Collections` is ordered union and deduped;
- output `Mine Related Notes` is ordered union and deduped;
- bodyful articles preserve body Markdown;
- empty-body media cards become `![[media]]` body sections;
- empty-body link cards become Markdown link sections;
- sections are separated by `---`;
- per-section `Source:` and `Author:` append only when present;
- media files are not copied or deleted;
- selected source `.md` files are deleted only after merged `.md` exists;
- external `Mine Related Notes` refs to selected source slugs rewrite to the
  merged slug;
- external body wikilinks to selected source slugs rewrite to the merged slug;
- block-reference fragments survive many-to-one rewrite;
- malformed external file fails recoverably before deleting sources;
- index rows for removed, rewritten and new files are refreshed.

### Frontend Tests

- bottom action island shows `Merge` only for two or more selected cards;
- action order is `Connect`, optional `Disconnect`, `Merge`, `Delete`;
- focused-card batch menu shows `Merge` only for two or more selected cards;
- dialog opens with selected cards in Grid visual order;
- dialog rows reuse the shared card-reference row component markers;
- drag handle reorders rows without opening cards;
- confirm sends exactly the visible row order to `mergeBlocks`;
- command failure keeps dialog open and selection intact;
- success closes dialog, clears selection and removes selected frames;
- success preserves viewport anchor after masonry reflow;
- media thumbnails in dialog use `MicroPreviewThumbnail` cache-bust contract.

### Manual QA

- merge mixed article, image, video/file and link cards;
- merge cards from multiple collections and verify resulting membership;
- merge cards where an external excerpt card points to one selected source via
  `Mine Related Notes`;
- inspect raw `.md` in Obsidian and verify readable body, wikilinks and
  frontmatter;
- verify no new media files appear in the vault;
- verify no media files disappear from the vault;
- verify light/dark dialog visuals and bottom island layout;
- verify large selected set scrolling and reorder behavior.
