# Text Selection Extraction Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)

## Status

Implemented v1. Runtime support exists for selecting text in `Detail`, dragging
the selection proxy handle onto a sidebar collection, creating a snapshot
article card, and anchoring the source paragraph with an Obsidian block id when
needed.

## Goal

Пользователь может открыть article-карточку в `Detail`, выделить отрезок
текста и перетащить появившуюся selection handle на коллекцию в sidebar. Mine
создаёт новую article-карточку в этой коллекции. Тело новой карточки содержит snapshot
выделенного текста, а frontmatter содержит ссылку на исходный блок текста через
Obsidian block reference.

Dragging the highlighted native text range itself is not a Mine command. Mine
does not attach extraction metadata to native selected-text drag/drop; the
visible selection handle is the only supported creation affordance.

Главный контракт: это не live-sync и не embedded transclusion. Новая карточка
не подтягивает будущие изменения исходного параграфа. Block reference нужен как
человекочитаемый якорь для обратного перехода к месту в исходной статье.

## Product Contract

### User Scenario

1. Пользователь открывает article-блок в `Detail`.
2. Пользователь выделяет текст внутри тела статьи.
3. Mine показывает маленькую drag-ручку рядом с первым выбранным блоком.
4. Пользователь перетаскивает эту ручку на коллекцию в sidebar.
5. Mine создаёт новый article-блок в целевой коллекции.
6. Новый блок содержит только выделенный текст.
7. Новый блок связан с исходной статьёй через `Mine Related Notes` target
   `[[Source Article#^block-id]]`.
8. Исходная статья получает block id только если у первого выбранного
   параграфа ещё нет существующего Obsidian block id.

### What v1 Does Not Do

| Area | Decision |
|---|---|
| Live synchronization | No. The excerpt body is a creation-time snapshot |
| Exact text range anchors | No. Obsidian-compatible anchor points to a Markdown block, not a character range |
| Multiple source anchors | No. A multi-paragraph selection links to the first selected paragraph only |
| Hidden sidecar metadata | No. No JSON sidecar, UUID registry, or HTML comments |
| Source backlink insertion | No. The source article gets only the block id suffix when needed |
| Non-article source blocks | No. v1 accepts article/implicit article body selections only |
| Native selected-text drag action | No. Card creation only runs from the selection handle |

## Obsidian Source Format

Mine uses native Obsidian block reference syntax:

```markdown
The paragraph that starts the selected range. ^attention-is-selection
```

The new card links to that block:

```yaml
Mine Related Notes:
  - "[[Source Article#^attention-is-selection]]"
```

Rules:

1. If the first selected paragraph already ends with a block id, reuse it.
2. If it has no block id, append one at the end of that paragraph.
3. Do not add frontmatter to the source article just to store an anchor.
4. Do not add a backlink paragraph to the source article.
5. Preserve every source byte outside the single block id insertion.
6. If Mine cannot patch the source safely, fail recoverably and do not create
   the excerpt card.

## Selection Semantics

### Selection Inside One Paragraph

The excerpt body is exactly the selected text, normalized only enough to produce
valid Markdown. The source link points to the paragraph that contains the
selection.

Source:

```markdown
Attention is selection, and selection is a way of making value visible.
```

Selected text:

```text
selection is a way of making value visible
```

Patched source:

```markdown
Attention is selection, and selection is a way of making value visible. ^attention-is-selection
```

New card body:

```markdown
selection is a way of making value visible
```

### Selection Across Multiple Paragraphs

The excerpt body includes the selected text across paragraphs. The source link
anchors only the first selected paragraph.

This is intentionally imprecise but correct for the product job: on reverse
navigation, Mine and Obsidian bring the user to the start/context of the source
passage. Exact range highlighting is out of scope because Obsidian block
references are block anchors, not character offsets.

### Unsupported Source Shapes

v1 should support normal paragraphs and list items. It should reject ambiguous
or lossy source patches such as fenced code blocks, Markdown tables, raw HTML
blocks, and selections that cannot be mapped back to a stable source span.

The rejection must be non-destructive: no source patch, no new card, and a
recoverable UI error.

## Block Id Generation

Block ids should be human-readable and stable enough to survive user inspection.

Rules:

1. Allowed generated characters: `A-Z`, `a-z`, `0-9`, `-`.
2. Derive the base id from the first selected paragraph or selected text.
3. Prefer short ids, for example `attention-is-selection`.
4. If the id already exists in the source note, append `-2`, `-3`, etc.
5. If no readable id can be derived, fallback to `excerpt-YYYYMMDD-N`.
6. Never generate hidden UUIDs unless a future explicit migration changes this
   contract.

## New Card Format

Example result for dragging selected text from `Source Article.md` to
collection `Ideas`:

```markdown
---
type: article
Mine Collections:
  - "[[Ideas]]"
Mine Related Notes:
  - "[[Source Article#^attention-is-selection]]"
saved_at: 2026-05-01T14:30:00Z
source: text-selection-extraction
---

selection is a way of making value visible
```

Fields:

| Field | Required | Value |
|---|---:|---|
| `type` | yes | `article` |
| `Mine Collections` | yes | Target collection from sidebar drop as quoted Obsidian wikilink |
| `Mine Related Notes` | yes | Source note block reference as quoted Obsidian wikilink |
| `saved_at` | yes | Creation time |
| `source` | yes | Literal `text-selection-extraction` |

The body contains the selected text snapshot only. It should not include a
manual backlink paragraph because provenance already lives in `Mine Related
Notes`.
Text-selection extraction follows [SPEC_DISPLAY_TITLE.md](./SPEC_DISPLAY_TITLE.md):
it does not synthesize `title:` frontmatter and does not create an H1 from the
selected text. A quote that is one word remains a one-word body. The filename
may be seeded from the selected text for readability, but that seed is not
persisted as block metadata.

## Snapshot Semantics

The excerpt body is independent after creation:

1. Editing the source paragraph does not rewrite the excerpt body.
2. Editing the excerpt body does not rewrite the source paragraph.
3. Moving the source paragraph inside the same note preserves the reverse link
   as long as the `^block-id` remains attached to that paragraph.
4. Deleting the `^block-id` in Obsidian breaks the precise anchor, but the note
   target can still be shown as a degraded related note.
5. Renaming the source note in Mine must rewrite the note portion of
   `[[Source Article#^block-id]]` while preserving `#^block-id`.

## Command Contract

### Tauri Command

```rust
#[tauri::command(rename_all = "snake_case")]
async fn extract_text_selection(
    state: State<'_, AppState>,
    source_slug: String,
    target_tag: String,
    selected_text: String,
    first_block_start: usize,
    first_block_end: usize,
    source_body_hash: String,
) -> Result<IndexedBlock, TextSelectionExtractError>
```

### Parameters

| Parameter | Value |
|---|---|
| `source_slug` | Filename stem / vault slug of the open source article |
| `target_tag` | Obsidian collection ref from sidebar drop |
| `selected_text` | Text snapshot selected by the user |
| `first_block_start` | Byte offset of the first selected Markdown block in source body |
| `first_block_end` | Byte offset end of that block in source body |
| `source_body_hash` | Body hash read by the frontend when selection started |

The byte offsets are source-body offsets after frontmatter split, not rendered
DOM offsets. The frontend may derive them from a backend-provided render map or
from a future selection mapping API. The backend remains authoritative: it must
re-read the file and verify the hash/range before writing.

### Algorithm

1. Validate vault state, source slug, target collection ref, and non-empty
   `selected_text`.
2. Read the source `.md` file and split frontmatter/body.
3. Verify `source_body_hash` still matches the current body. If it does not,
   return a stale-selection error.
4. Verify `first_block_start..first_block_end` identifies a supported Markdown
   block; if no range is provided, locate `selected_text` in the current source
   body and use the block containing it.
5. Reuse an existing block id on that Markdown block, or generate and insert a
   unique block id.
6. Suppress watcher events for the source file during the in-app source patch.
7. Create a new article block with `Mine Collections`, `Mine Related Notes`,
   `saved_at`, `source: text-selection-extraction`, and snapshot body.
8. Persist the new block through the reference-block path; no media copy is
   involved.
9. Index the new block and generate its text thumbnail.
10. Re-index the patched source block so the derived body hash and wikilinks are
    current.
11. Emit normal `block:added` / `thumb:updated` events for the new block. The
    patched source block is re-indexed immediately; Detail remains open on the
    source article.
12. Return `IndexedBlock` for immediate UI update.

### Errors

```rust
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TextSelectionExtractError {
    NoVault,
    SourceNotFound { source_slug: String },
    SourceNotArticle { source_slug: String, block_type: String },
    EmptySelection,
    StaleSelection,
    UnsupportedSelectionShape { reason: String },
    UnsafeSourcePatch { reason: String },
    InvalidCollectionRef { reason: String },
    Internal { message: String },
}
```

Frontend should show a non-destructive inline error/toast. The source `Detail`
stays open.

## Frontend Contract

### Drag Payload

```ts
type TextSelectionDragPayload = {
  type: "text_selection";
  sourceSlug: string;
  selectedText: string;
  firstBlockStart: number;
  firstBlockEnd: number;
  sourceBodyHash: string;
};
```

Rules:

1. `type: "text_selection"` never falls through to the card drop path.
2. Drop target must be a concrete collection, not `Everything`.
3. Drag overlay previews the selected text, not the full source card.
4. Detail remains open on the source article after extraction.
5. UI renders `Mine Related Notes` as provenance/source context, not as a
   synced body.

### Drop Handling

| Active payload | Drop target | Behavior |
|---|---|---|
| `block` | `collection:<ref>` | Existing connect-to-collection path |
| `inline_media` | `collection:<ref>` | Existing `extract_inline_media` path |
| `text_selection` | `collection:<ref>` | New `extract_text_selection` command |
| `text_selection` | anything else | No-op |

After success, the frontend relies on the same event-driven refresh path used
by inline-media extraction. It must not run a full vault reload from the drop
handler.

## Rename And Link Rewrite Contract

Block references preserve two pieces of identity:

```text
[[Source Article#^attention-is-selection]]
  note target: Source Article
  block id:    attention-is-selection
```

In-app rename of the source note must rewrite only the note target:

```diff
- [[Source Article#^attention-is-selection]]
+ [[Renamed Source#^attention-is-selection]]
```

This applies to:

1. Body wikilinks.
2. `Mine Related Notes` frontmatter values.
3. Any link parser/indexer that resolves relationship targets.

The relationship index may store the full target for display/opening, but it
must also be able to resolve the base note target for existence checks and
rename rewrites.

## Obsidian Compatibility

The resulting files are useful outside Mine:

1. Obsidian opens the excerpt card as a normal Markdown note.
2. Obsidian properties show `Mine Related Notes` as a readable link string.
3. The source note uses native `^block-id` syntax.
4. No Mine-only hidden markers are required to navigate back.
5. A user can manually edit or remove the block id in Obsidian; Mine degrades
   gracefully instead of treating the file as corrupt.

## Testing Plan

### Rust Unit Tests

| Area | Scenarios |
|---|---|
| source patch | append block id to paragraph, reuse existing id, unique suffix, preserve unrelated bytes |
| selection validation | empty selection, stale body hash, unsupported code/table/html shapes |
| block serialization | new card with `Mine Related Notes: [[Source#^id]]` |
| index | related note with block reference indexed and returned by `get_block` |
| rename | source rename preserves `#^id` in body links and `Mine Related Notes` |

### Frontend Tests

| Area | Scenarios |
|---|---|
| Detail | valid native selection shows a separate drag handle, not a draggable article body |
| Detail | same selected text in different paragraphs anchors to the selected rendered block offsets |
| Detail | selected text remains native selection/copy/context-menu UI before drag |
| Detail/Sidebar | native selected-text drag/drop does not create a Mine card |
| App drop | `text_selection` dropped on collection calls `extractTextSelection` |
| App drop | `text_selection` does not call block connect or inline-media extraction |
| Detail | source Detail remains open after extraction |
| Metadata | related note with `#^id` opens the source article at anchor when possible |

### Manual QA

1. Open article with multiple paragraphs.
2. Select part of one paragraph and verify normal highlight, double-click,
   triple-click, `Cmd+C`, and context menu still work.
3. Drag the selection handle to a collection.
4. Verify the source paragraph received one readable `^block-id`.
5. Verify the new card body contains only selected text.
6. Verify `Mine Related Notes` points to `[[Source#^block-id]]`.
7. Select text across two paragraphs and repeat.
8. Verify only the first paragraph is anchored.
9. Edit the source paragraph and verify the excerpt body does not change.
10. Rename the source article in Mine and verify the excerpt's related note
   target updates while keeping `#^block-id`.
11. Click the excerpt card's related note in Mine and verify Detail opens the
    source article at the anchored paragraph.
12. Open both files in Obsidian and verify they remain readable Markdown.

## Acceptance Criteria

- [x] Text selected in Detail can be dragged independently from the source
      article card.
- [x] Dropping on a sidebar collection creates a new article card in that
      collection.
- [x] New card body is a snapshot of the selected text.
- [x] Source note is patched only with a native Obsidian block id when needed.
- [x] Multi-paragraph selections link only to the first selected paragraph.
- [x] Source edits do not auto-sync into the excerpt card.
- [x] `Mine Related Notes` stores `[[Source#^block-id]]`.
- [x] Clicking that related note in Mine opens the source article at the
      anchored paragraph when the marker is still present.
- [x] Source note rename preserves the block anchor.
- [x] Existing card drag and inline-media drag remain unchanged.
- [x] Unsupported selections fail without source mutation.

## Implementation Slices

| Slice | Scope | Verification |
|---|---|---|
| T.1 | Source block-id parser/patcher with byte-preservation tests | Rust unit tests |
| T.2 | Related-note block-reference parsing, indexing, and rename rewrite | Rust storage/domain tests |
| T.3 | `extract_text_selection` command | Rust command tests |
| T.4 | Detail selection mapping and drag payload | TypeScript build + manual QA |
| T.5 | App drop routing and event-driven refresh | TypeScript build + App tests |
| T.6 | Related-note UI opens the source article and scrolls to `#^id` when the block-id marker exists | Frontend/component manual QA |
