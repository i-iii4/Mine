# SPEC: Obsidian-First Collections

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md)

## Status

Implemented for normal runtime writes and reads. The source migration is handled
by the reviewable CLI:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin migrate-collections-to-wikilinks -- --dry-run <vault>
cargo run --manifest-path src-tauri/Cargo.toml --bin migrate-collections-to-wikilinks -- --apply <vault>
```

The SQLite schema still contains legacy physical names (`channels.tag`,
`block_tags.tag`), but their semantic value is now `CollectionRef`. Legacy
normalized values and raw `Mine Collections` values are migration inputs only,
not normal runtime formats.

`blocks.collection_index_version` protects the derived SQLite read model from
older parser rules. On upgrade, Mine may rebuild `block_tags` from source
Markdown in the local index only; this is not a source-file migration and must
not rewrite user files.

## Decision

Mine collections are Obsidian pages.

Membership is stored as quoted Obsidian wikilinks in the Mine-owned
`Mine Collections` property:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
  - "[[Design References]]"
```

The collection page itself is a normal Markdown file with a human-readable
filename:

```markdown
---
type: channel
saved_at: 2026-04-29T12:00:00Z
position: 0
---
```

File:

```text
Красивый веб.md
```

Not:

```text
красивый-веб.md
```

## Goals

- Make Mine collection membership visible in Obsidian as ordinary note links.
- Keep `tags` fully user-owned; Mine must not use Obsidian `tags` as its
  canonical collection field.
- Keep files human-readable: collection names in source files should be the
  names users see in Mine and Obsidian.
- Stop using kebab/lowercase normalized filenames as collection identity.
- Preserve collection order and collection metadata in collection pages.
- Use a one-time, reviewable migration instead of indefinite legacy support.

## Non-Goals

- No metadata is embedded into binary image/video files.
- No hidden UUID is written to cards or collection pages.
- No central SQLite-only source of truth for collection membership.
- No automatic rewrite of source Markdown on ordinary read/index/open.
- No use of `tags` as Mine collections after migration.

## Source Format

### Card Membership

Canonical post-migration format:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
```

Rules:

- The YAML value is a string containing an Obsidian wikilink.
- The string must be quoted because `[` and `]` are YAML flow-collection
  characters.
- The wikilink target is the collection page target.
- Mine writes the target without alias by default.
- Aliases may be read for compatibility, but Mine should not create aliases
  unless a future explicit UX requires them.

Accepted read examples for the canonical parser:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
  - "[[Design/References]]"
  - "[[Research|Research board]]"
```

For `[[target|alias]]`, Mine collection identity is `target`, not `alias`.

### Collection Page

Collection pages are ordinary `.md` files in the vault:

```yaml
---
type: channel
position: 12
saved_at: 2026-04-29T12:00:00Z
---
```

Rules:

- The filename is the primary human-readable Obsidian page target.
- Mine does not write or read a separate collection `title`; display text comes
  from the filename / wikilink target.
- `position` stores sidebar order.
- Future collection metadata such as color, icon, or description belongs on
  the collection page.

## Identity

Runtime identity is `CollectionRef`, derived from the Obsidian wikilink target.

Normalization is intentionally minimal:

- Unicode normalization at filesystem boundaries is allowed.
- Path separator handling follows the same rules as Obsidian link targets.
- URL routes percent-encode the ref.
- Mine must not lowercase, kebab-case, collapse spaces, or otherwise normalize
  different page names into one identity.

Examples that must remain distinct when the filesystem can represent them:

```text
Красивый веб
красивый-веб
Красивый-Веб
```

On default macOS case-insensitive filesystems, case-only duplicates may not be
representable. That is a filesystem limitation, not a Mine normalization rule.

## Write Contract

After migration, every Mine write path writes only the canonical wikilink
format:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
```

Affected paths:

- web clipper save;
- app create/save;
- drag card to collection;
- checkbox connect/disconnect in Detail sidebar;
- inline media extraction;
- collection rename;
- collection reorder when collection pages are created or patched.

Mine must not create or update `frontmatter.tags` for collection membership.

## Legacy Policy

Legacy support is migration-only, not a permanent runtime contract.

The migration tool reads old collection encodings:

```yaml
tags:
  - красивый-веб

Mine Collections:
  - Красивый веб

Mine Collections:
  - красивый-веб
```

The app's normal runtime does not treat these forms as collection membership.
If a legacy form appears after migration, the fix is to rerun the migration
tool rather than silently maintaining a second source format.

User-owned Obsidian `tags` are preserved. The migration must not delete or
rewrite `tags` unless the user explicitly chooses a cleanup mode for files that
are proven Mine-authored legacy files.

Local indexes created by older versions may still contain user-owned Obsidian
`tags` in `block_tags`. Runtime startup and native-host channel listing must
run the versioned collection-index backfill, replacing those stale rows with
memberships parsed only from `Mine Collections`.

## Migration Plan

### M1. Dry Run

Scan the vault and report:

- files with legacy Mine collections in `tags`;
- files with raw `Mine Collections` values;
- existing collection pages with normalized filenames;
- proposed canonical `Mine Collections` wikilink values;
- proposed collection page renames;
- conflicts and ambiguous mappings.

No source file changes in dry-run.

Implemented by `migrate-collections-to-wikilinks --dry-run`.

### M2. Backup

Before apply, create timestamped backups of every file that will be changed.
The backup must be enough to restore the exact previous bytes of each file.

Implemented by `migrate-collections-to-wikilinks --apply`, which writes
timestamped byte backups under `.mine-migration-backup/`.

### M3. Collection Page Rewrite

For each collection:

1. Choose the human page name from existing `title` if present, otherwise from
   the best available display name.
2. Rename normalized collection files to human filenames when safe.
3. If two collection pages are materially different, keep both as distinct
   pages instead of collapsing them.
4. If two files conflict at the same path, stop and report the conflict instead
   of overwriting.

Implemented for root collection pages. Nested Obsidian targets are reported as
conflicts by the migration CLI instead of being guessed.

### M4. Card Membership Rewrite

For each card:

1. Convert Mine-owned collection membership to quoted wikilinks.
2. Write only `Mine Collections`.
3. Preserve user-owned `tags`.
4. Preserve unrelated frontmatter fields, comments, ordering, and scalar style
   as far as the existing patcher can safely do so.

Implemented for normal runtime writes and the migration CLI.

### M5. Rebuild And Verify

After apply:

- rebuild the local index;
- compare collection counts before and after;
- verify sidebar order from collection page `position`;
- open sample files in Obsidian and confirm graph links from cards to
  collection pages;
- verify clipper/app writes produce only canonical wikilink values.

## Storage Migration Notes

The current schema names (`channels.tag`, `block_tags.tag`) are legacy names.
During implementation they may either be:

1. renamed to collection-oriented names, or
2. kept as physical column names while their semantic meaning changes to
   `collection_ref`.

Either way, the data stored after migration must be the Obsidian collection ref,
not a normalized tag.

`block_tags` is a derived read model. Its rows must be rebuilt from
`Mine Collections` when `blocks.collection_index_version` is absent or older
than the current parser version. Rebuilding this table must not mutate the
Markdown source.

## Frontend Migration Notes

Routes should encode collection refs instead of normalized tags. The UI label is
the collection page display name. Drag/drop, checkbox connect/disconnect, and
sidebar filtering all operate on `CollectionRef`.

## Acceptance Criteria

- A new saved card writes `Mine Collections: ["[[Name]]"]`.
- Obsidian graph links the card to the collection page.
- `tags` remains untouched by Mine collection operations.
- Human collection filenames are not auto-canonicalized to kebab/lowercase.
- Existing vault files can be migrated in one explicit apply step.
- After migration, no normal Mine write path emits raw collection strings or
  legacy `tags` membership.
- After upgrade, stale `block_tags` rows derived from Obsidian `tags` disappear
  after the background collection-index backfill.
