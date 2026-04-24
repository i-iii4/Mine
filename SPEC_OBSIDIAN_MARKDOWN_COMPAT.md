# Obsidian Markdown Compatibility Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md)

## Goal

Сделать обычные Obsidian Markdown-файлы first-class readable material в Mine.

`.md` файл без Mine frontmatter должен индексироваться и отображаться как
обычная article/note карточка. Mine не должен требовать предварительной
конвертации, добавления `type:` или переписывания исходного текста, чтобы
пользователь увидел Obsidian-материал в ленте.

## Non-goals

- Не отменять frontmatter для Mine-authored blocks.
- Не превращать каждый Markdown-файл в полноценный Mine-owned block с
  агрессивными write/cleanup semantics.
- Не менять canonical wikilink syntax из `SPEC_OBSIDIAN_WIKILINKS.md`.
- Не делать папки каналами. Каналы по-прежнему tags/collections, а не
  filesystem directories.
- Не делать H1 приоритетнее имени файла в v1. Filename-first остаётся
  контрактом identity/display fallback; H1 остаётся частью body.

## Motivation

Текущий контракт слишком жёсткий для Obsidian compatibility: отсутствие
frontmatter трактуется как parse error, хотя для человеческого сценария это
обычная статья с понятным заголовком, датой файла, текстом и локальными
`![[image.jpg]]` embeds.

Frontmatter нужен для явной Mine-метадаты, но не должен быть входным билетом
для read-only отображения Markdown.

Правильная модель:

- **read path permissive** — обычный `.md` можно показать без вмешательства;
- **write path explicit** — Mine добавляет frontmatter только когда пользователь
  совершает действие, которому нужна Mine-метадата.

## Concepts

### Mine Markdown

Файл с YAML frontmatter в начале:

```md
---
type: article
title: Example
saved_at: 2026-04-24T12:00:00Z
tags:
  - design
---

Body.
```

Это полный Mine block. Frontmatter является source of truth для explicit
metadata.

### Foreign Markdown

Файл без opening frontmatter fence:

```md
# Example

Body.

![[image.jpg]]
```

Это обычный Markdown-файл, написанный пользователем или Obsidian. Mine должен
читать его как implicit article/note, не меняя файл на read path.

### Partial Frontmatter Markdown

Файл с YAML frontmatter, но без части Mine-полей:

```md
---
tags:
  - design
---

# Example
```

Это не ошибка. Mine должен применять explicit поля из frontmatter и выводить
недостающие поля из fallback rules.

## Read Model

Indexer строит `Block` из `.md` файла через двухступенчатую модель:

1. Parse explicit frontmatter if present.
2. Fill missing fields from implicit Markdown/file metadata.

### Field Precedence

| Field | Explicit source | Fallback source |
|---|---|---|
| `type` | known Mine `frontmatter.type` | `article` |
| `title` | `frontmatter.title` | filename stem |
| `saved_at` | `frontmatter.saved_at` | filesystem creation time → modified time |
| `tags` | `frontmatter.tags` | empty list |
| `url` | `frontmatter.url` | `null` |
| `description` | `frontmatter.description` | `null` |
| `file` | `frontmatter.file` | `null` |
| `thumbnail` | `frontmatter.thumbnail` | `null` |
| `author` | `frontmatter.author` | `null` |
| `body` | text after closing frontmatter | whole file for foreign Markdown |

Rules:

- If `frontmatter.type` exists and is a known Mine block type, it wins.
- If `frontmatter.type` exists but is unknown to Mine, it is preserved as user
  YAML and the indexed block falls back to `article` with an index warning.
- If `frontmatter.title` exists, it wins over filename.
- If `frontmatter.saved_at` exists and parses, it wins over filesystem
  timestamps.
- If `frontmatter.saved_at` exists but is invalid, Mine falls back to
  filesystem date with an index warning and preserves the original YAML.
- If `frontmatter.tags` exists, it is normalized by the tag compatibility
  rules below. Unrecognized tag shapes are warnings, not hard parse errors.
- Missing optional fields stay missing; Mine does not synthesize `url`,
  `file`, `thumbnail`, `author`, `width`, or `height`.

### Derived-only Fields

The index may store derived fields that are never written back to the source
Markdown unless the user explicitly owns that metadata in Mine:

- `origin`: `mine_frontmatter`, `partial_frontmatter`,
  `foreign_markdown`, or `malformed_frontmatter`;
- `index_warning`: a concise warning such as `unknown_type`,
  `invalid_saved_at`, `malformed_frontmatter`, or `unsupported_tag_shape`;
- media-derived fields such as `first_image`, `media_urls`,
  `preview_manifest`, and `media_dimensions`.

`source` is not a required compatibility field. If a user file already contains
`source`, Mine preserves it, but Mine must not inject a `source` marker just to
classify an Obsidian file.

### Title Fallback

For Markdown without explicit `title`:

1. Filename stem.

This preserves the existing filename-first identity model: the human-readable
`.md` filename is both the stable block identity (`slug`) and the default
display title when no explicit `frontmatter.title` exists.

Headings remain part of body. An H1 can be used later as a preview/content
signal, but v1 must not let H1 override filename-derived display title. This
avoids ambiguity when an Obsidian note is named one way but starts with a
different heading.

### Date Fallback

For Markdown without explicit `saved_at`:

1. Filesystem birth/creation time if available.
2. Filesystem modified time.

The derived date is stored in SQLite index, not written into source markdown
unless the user performs a write action requiring frontmatter.

### Body Fallback

For foreign Markdown, body is the entire file. For partial frontmatter Markdown,
body is everything after the closing frontmatter fence.

Obsidian wikilinks and embeds are handled by the existing dual-syntax read path:

- `![[image.jpg]]`
- `![[image.jpg|alt]]`
- `![alt](image.jpg)`

### Tag Compatibility

Obsidian-compatible tag parsing is best-effort and fail-open:

- `tags: design` indexes `design`.
- `tags: [design, typography]` indexes `design` and `typography`.
- YAML list syntax indexes every scalar string item.
- `tags: "design typography"` is split on whitespace because Obsidian tags
  cannot contain spaces.
- Nested Obsidian tags such as `design/typography` are valid tag values and
  must not be rejected because of `/`.
- Leading `#` is accepted and stripped for frontmatter tag values.
- Inline body tags such as `#typography` and `#design/typography` remain body
  text in v1. They may participate in full-text search, but they are not
  promoted into frontmatter tags and assigning/removing Mine collections must
  not rewrite body inline tags.

If `tags` has an unsupported YAML shape, Mine indexes the file with the tags it
can safely read, records an `index_warning`, and leaves the original YAML
unchanged.

## Frontmatter Parsing Contract

The parser must distinguish four cases:

1. **No frontmatter fence** — valid foreign Markdown.
2. **Horizontal-rule ambiguity** — if the file starts with `---` but Mine does
   not find a closing frontmatter fence in the scan window, the opening `---`
   is treated as Markdown body, not as a parse error.
3. **Valid/partial frontmatter fence** — valid Markdown with explicit metadata
   overlay. Empty frontmatter (`---\n---\n`) is valid partial frontmatter and
   body starts after the closing fence.
4. **Malformed fenced frontmatter** — a frontmatter fence exists, but its YAML
   cannot be parsed. The file still indexes as an implicit article with an
   `index_warning`; Mine must not hide it from the feed.

Frontmatter recognition:

- A candidate frontmatter block requires `---` on the first line and a closing
  `---` before body content, within the implementation's bounded scan window
  (v1 target: first 20 lines).
- If no closing fence is found in that window, Mine treats the whole file as
  body. This preserves normal Markdown/Obsidian files that begin with a
  horizontal rule.
- If a closing fence is found but YAML is invalid, Mine indexes the whole file
  body including the raw fenced text, records `malformed_frontmatter`, and does
  not attempt to patch that frontmatter automatically.

The following are not hard parse errors:

- unknown `type` values such as `meeting`, `project`, `zettel`;
- invalid `saved_at`;
- unsupported `tags` shapes;
- unknown Obsidian/user fields such as `aliases`, `cssclasses`, `created`,
  `updated`, or arbitrary custom metadata.

## Indexing

### Storage Index

`storage/index` must upsert implicit Markdown blocks into the same `blocks`
table as Mine blocks, using the derived read model.

For an indexed Markdown file:

- `slug` = filename stem;
- `block_type` = known Mine `frontmatter.type` if present, otherwise
  `article`;
- `title` = valid `frontmatter.title` if present, otherwise filename stem;
- `saved_at` = valid `frontmatter.saved_at` if present, otherwise filesystem
  fallback;
- `index_warning` = warning code when metadata was downgraded or skipped,
  otherwise null;
- `media_file` = null;
- `thumbnail` = null;
- `body` = full markdown for foreign/malformed Markdown; text after closing
  fence for valid partial/Mine frontmatter;
- `tags` = compatible frontmatter tags if present, otherwise empty;
- `first_image`, `media_urls`, `preview_manifest`, `media_dimensions` are
  derived from body exactly like article blocks with frontmatter.

### Rebuild Idempotency

Deleting and rebuilding `index.db` must reproduce the same implicit rows from
the same files and filesystem timestamps.

If filesystem creation time is unavailable or changes after copy/import, Mine
may use modified time. That is acceptable for foreign Markdown because no
explicit Mine save timestamp exists.

## Preview and Thumbnail Contract

Foreign Markdown uses the existing article thumbnail cascade:

1. First local embedded image/video in body (`![[...]]` or legacy markdown).
2. Text thumbnail fallback if no local media exists.

The preview pipeline must not require `frontmatter.file` or `type: article` to
exist in source text. It consumes the derived `Block` read model.

## Frontend Display

Foreign Markdown displays as article/note:

- feed card uses article layout;
- title uses derived title;
- body preview strips embeds as existing article preview does;
- detail renders full markdown body through existing wikilink preprocessing;
- local embeds render from vault media files;
- metadata panel may show filename and derived date, but should not imply that
  `saved_at` exists in source frontmatter.

No special feed badge or detail warning is required for v1. `index_warning`
is stored for diagnostics and future UI, but normal reading surfaces should not
add warning chrome in the first implementation.

## Write Model

### Read Path Never Writes

Opening Mine, rebuilding index, generating previews, searching, reading detail,
and rendering feed must never add frontmatter to foreign Markdown.

### Explicit Mine Actions May Add Minimal Frontmatter

Mine writes frontmatter only when a user action requires persisted Mine
metadata. Examples:

- assign to collection/tag;
- rename through Mine if the operation also rewrites links/media;
- change type explicitly;
- attach source URL or other Mine-specific metadata.

The first Mine write to foreign Markdown does not show a prompt in v1. The
user action itself, such as assigning a tag or collection, is treated as intent
to persist the minimal metadata required for that action.

When frontmatter is added to a foreign Markdown file, Mine must preserve body
byte-for-byte except for inserting the frontmatter block at the top.

Minimal adoption on assigning to a collection:

```md
---
tags:
  - design
---

# Existing Obsidian Note

Body.
```

Do not add `type`, `title`, or `saved_at` just because the file is being tagged.
Fallback rules continue to provide those values.

If a user action explicitly writes `saved_at` during adoption, the value must be
the action time (`now()`), not the filesystem creation/modification time. Mine
must not imply that it originally saved an old user-owned file.

### Partial Frontmatter Update

If a file already has frontmatter but lacks `type` / `saved_at`, updating tags
must preserve that partial frontmatter and add only the needed field:

```md
---
aliases:
  - Example
tags:
  - design
---
```

Unknown Obsidian YAML fields must be preserved. Mine-owned serializers must not
drop `aliases`, `cssclasses`, custom user fields, or comments when editing a
partial frontmatter file.

### Frontmatter Patching Invariant

Mine must not round-trip user frontmatter through a lossy YAML serializer for
compatibility writes.

For v1, the conservative contract is:

- patch only the field required by the user action, usually `tags`;
- preserve every byte outside the patched field range, including comments,
  unknown fields, ordering, scalar style, literal/folded strings, anchors, and
  aliases;
- if Mine cannot identify a safe patch range, do not write automatically;
  surface a recoverable warning instead;
- malformed fenced frontmatter is read-only until the user repairs it or
  explicitly chooses a recovery flow.

This deliberately avoids a broad YAML AST rewrite. A future implementation may
adopt a comment/style-preserving YAML parser, but it must still satisfy the same
byte-preservation contract for unrelated fields.

## Mutation Safety

Foreign Markdown is safe to read and index. Mutations require care:

| Action | Foreign Markdown behavior |
|---|---|
| Read/list/search/detail | allowed, no write |
| Generate thumbnail/preview | allowed, derived cache only |
| Assign tag/collection | allowed, patch/add frontmatter tags only |
| Remove tag/collection | allowed if tags are in frontmatter; remove only Mine tag entry |
| Rename in Mine | allowed only if rename path preserves Obsidian links and unknown frontmatter |
| Delete block | allowed only after existing delete confirmation |
| Media cleanup | must not delete embedded media solely because no `file:` exists; media referenced by body wikilinks such as `![[name.jpg]]` is protected |
| Web clipper save | unchanged; clipper continues writing Mine frontmatter |

## Directory / Import Scenarios

### User Drops `.md` Files Into Vault

Watcher indexes them as implicit articles. No conversion.

### User Drags Obsidian Files Into Mine

If the drop copies files into the vault, indexer treats them the same as files
manually placed in the vault. No conversion on import.

### User Assigns A File To A Collection

Mine writes or patches frontmatter with `tags`. The file remains ordinary
Markdown with optional YAML metadata, compatible with Obsidian.

Once Mine inserts a frontmatter fence, the file is classified as partial
frontmatter on subsequent reads. Removing all Mine tags does not automatically
strip the empty fence; `---\n---\n<body>` remains valid partial frontmatter.

### User Moves File Outside Vault

Existing delete/rename detection applies. The block leaves the index if the
source `.md` no longer exists in the vault.

## Error Handling

| Situation | Behavior |
|---|---|
| `.md` has no frontmatter | valid implicit article |
| `.md` has valid partial frontmatter | valid article unless known explicit Mine `type` says otherwise |
| `.md` starts with `---` but has no closing fence | valid implicit article; whole file is body |
| `.md` starts frontmatter but YAML invalid | valid implicit article with `index_warning`; whole file is body |
| `.md` has unknown explicit `type` | valid implicit article with `index_warning`; original value preserved |
| `.md` has invalid explicit `saved_at` | valid article with filesystem date fallback and `index_warning` |
| `.md` has unsupported `tags` shape | valid article with best-effort tags and `index_warning` |
| embedded media file missing | article still indexes; preview falls back to next media or text |
| filesystem date unavailable | use modified time |

## Testing Plan

### Domain

- `parse_markdown_document_no_frontmatter_defaults_article`.
- `parse_markdown_document_partial_frontmatter_defaults_missing_type`.
- `parse_markdown_document_title_from_filename`.
- `parse_markdown_document_h1_does_not_override_filename_title`.
- `parse_markdown_document_saved_at_from_file_metadata`.
- `parse_markdown_document_hr_at_top_without_closing_fence_is_foreign`.
- `parse_markdown_document_empty_frontmatter_body_after_closing_fence`.
- `parse_markdown_document_unknown_type_downgrades_to_article_with_warning`.
- `parse_markdown_document_invalid_saved_at_uses_filesystem_with_warning`.
- `parse_markdown_document_malformed_yaml_indexes_with_warning`.
- `parse_markdown_document_nested_tag_slash_supported`.
- `parse_markdown_document_tags_scalar_string_and_list_supported`.
- `parse_markdown_document_inline_body_tag_does_not_mutate_tags`.
- `parse_markdown_document_unicode_filename_title`.

### Storage / Watcher

- full scan indexes `.md` without frontmatter as article.
- full scan no longer counts no-frontmatter file as error.
- implicit article with `![[image.jpg]]` fills `first_image`,
  `media_urls`, `preview_manifest`.
- existing Mine frontmatter behavior remains unchanged.
- stale DB row is replaced when file changes from Mine block to foreign
  Markdown and is reindexed.
- mass import of 10k foreign Markdown files completes within the agreed
  indexing performance budget.
- file edited externally during Mine frontmatter patch is detected and retried
  or surfaced as a conflict instead of overwriting newer bytes.

### Frontend

- feed renders implicit article card.
- detail renders Obsidian embed from implicit article body.
- metadata panel handles derived title/date without source frontmatter fields.
- `index_warning` is persisted for diagnostics, but not surfaced in normal v1
  UI.

### Write Path

- assigning tag to foreign Markdown inserts minimal frontmatter with `tags`.
- assigning tag to partial Obsidian frontmatter preserves unknown fields.
- assigning tag preserves `aliases`, `cssclasses`, comments, field ordering,
  multiline scalars, and unrelated custom YAML bytes.
- removing tag from partial frontmatter removes only that tag.
- removing the last Mine tag does not auto-strip an existing frontmatter fence.
- media cleanup never deletes files referenced by body wikilinks.

## Acceptance Criteria

- A plain Obsidian `.md` with text appears in Everything as an article card.
- A plain Obsidian `.md` with `![[image.jpg]]` uses that image as preview.
- Rebuilding the local index keeps those files visible.
- Opening Mine does not rewrite Obsidian files.
- Assigning a collection writes only the necessary tags metadata.
- Existing Mine-authored blocks with full frontmatter continue to behave
  exactly as before.
