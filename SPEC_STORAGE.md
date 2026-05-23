# SPEC: storage layer

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

Персистентный слой: SQLite-индекс, файловые операции, thumbnail-генерация.
Зависит от domain/ для типов. Не зависит от commands/ и watcher/.

---

## storage/db

Управление SQLite-соединением и схемой.

### Функции

```rust
open_or_create(path: &Path) -> Result<Connection>   // открыть или создать БД
open_memory() -> Result<Connection>                  // для тестов
```

### Схема

```sql
-- Блоки
CREATE TABLE blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    block_type TEXT NOT NULL, -- legacy frontmatter.type
    card_kind TEXT NOT NULL DEFAULT 'media', -- derived runtime card kind: article/media/channel
    title TEXT, -- legacy frontmatter.title only; new writes do not synthesize it
    description TEXT,
    url TEXT,
    media_file TEXT,
    thumbnail TEXT,
    saved_at TEXT NOT NULL,
    source TEXT,
    width INTEGER,
    height INTEGER,
    author TEXT,
    body TEXT DEFAULT '',
    preview_text TEXT,
    preview_text_cap INTEGER,
    preview_manifest TEXT,
    feed_playback TEXT,
    related_notes TEXT,
    thumb_format TEXT, -- derived thumb content: jpeg/png, NULL means no confirmed thumb
    thumb_mtime INTEGER, -- derived thumb mtime, NULL means no confirmed thumb
    media_index_version INTEGER,
    body_hash TEXT,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Теги
CREATE TABLE block_tags (
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (block_id, tag)
);
CREATE INDEX idx_block_tags_tag ON block_tags(tag);

-- Каналы
CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    color TEXT,
    icon TEXT,
    position INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

-- FTS5
CREATE VIRTUAL TABLE blocks_fts USING fts5(title, description, body);

-- Wikilinks
CREATE TABLE wikilinks (
    source_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_slug TEXT NOT NULL,
    PRIMARY KEY (source_id, target_slug)
);
```

FTS5 синхронизируется через триггеры (INSERT/DELETE/UPDATE на blocks) и
остаётся текущим lexical backend. Целевой Search contract добавляет
rebuildable derived stores для alias/transliteration и semantic chunks/
embeddings в local app data store; пользовательские `.md` файлы не
переписываются ради поиска.
`title` in the physical schema is legacy metadata. The body column carries
Markdown H1 text, so search still sees new content headings without storing a
generated `frontmatter.title`.

Surface Search query terms are escaped and sent to FTS5 as prefix tokens, e.g.
`mem` becomes `"mem"*`, so incremental typing finds `memory` without requiring
the full token.

Target hybrid search derived tables/indexes:

```sql
CREATE TABLE search_document_state (
    block_id INTEGER PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE search_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    field TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(block_id, field, chunk_index)
);

CREATE TABLE search_embeddings (
    chunk_id INTEGER NOT NULL REFERENCES search_chunks(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(chunk_id, model_id)
);
```

### Прагмы

- `PRAGMA journal_mode = WAL;` — параллельные чтения
- `PRAGMA foreign_keys = ON;` — каскадное удаление

---

## storage/index

Индексирование блоков в SQLite. Преобразование domain::Block в строки БД.

### Типы

```rust
struct IndexedBlock {
    id: i64,
    slug: String,
    block_type: BlockType, // legacy frontmatter.type
    card_kind: RuntimeCardKind, // derived source of truth for feed/detail/search
    title: Option<String>, // legacy frontmatter.title
    content_heading: Option<String>, // first body H1
    display_title: Option<String>, // content_heading, then legacy title
    fallback_label: String, // filename stem/media filename for utility surfaces
    description: Option<String>,
    url: Option<String>,
    media_file: Option<String>, // normalized from frontmatter.file wikilink/raw value
    thumbnail: Option<String>,
    saved_at: String,
    source: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    author: Option<String>,
    body: String,
    tags: Vec<String>,
}

/// Облегчённый блок для списков — без description и source.
/// `preview_text` — indexed read-model for feed cards: Markdown stripped,
/// whitespace normalized, and truncated on a word boundary to a backend
/// buffer, not to the final visual card height. `preview_text_cap` stores the
/// buffer version used to build it, so startup backfill can rebuild stale
/// rows exactly once after the cap changes. `body` remains a small legacy
/// excerpt for media fallback/detail lazy-load heuristics.
struct LightBlock {
    id: i64,
    slug: String,
    block_type: BlockType, // legacy frontmatter.type
    card_kind: RuntimeCardKind, // derived source of truth for feed/detail/search
    title: Option<String>, // legacy frontmatter.title
    content_heading: Option<String>,
    display_title: Option<String>,
    fallback_label: String,
    url: Option<String>,
    media_file: Option<String>, // normalized from frontmatter.file wikilink/raw value
    thumbnail: Option<String>,
    saved_at: String,
    width: Option<u32>,
    height: Option<u32>,
    author: Option<String>,
    body: String,
    preview_text: Option<String>,
    tags: Vec<String>,
}

struct TagCount {
    tag: String,
    count: usize,
}
```

`preview_text_cap` is currently `768` characters. The number is derived from
the frontend's widest single-column article card: 8 preview lines × ~478px
inner text width ÷ conservative ~5px average glyph width. The indexed value is
a bounded buffer for layout and IPC, while CSS line-clamp remains the final
visual cutoff.

`media_index_version` is the version marker for media-derived read-model
columns (`first_image`, `media_urls`, `media_dimensions`, `preview_manifest`,
`feed_playback`). When Obsidian embed resolution changes, startup backfill
rebuilds those cached columns from `body` and `media_file` without rewriting
source Markdown. Bulk backfill uses a cached basename resolver so vault-wide
attachment lookup is built once per pass, not once per note.

### Runtime/card kind derivation

Storage must not use `frontmatter.type` as the read-model source of truth for
feed/detail/search. During indexing:

1. `type: channel` derives `card_kind = channel`.
2. Any other block with non-empty body derives `article`.
3. Any other block with empty body derives `media`.

The physical `block_type` column keeps the parsed legacy/source type
(`image`, `link`, `video`, `file`, `article`, `channel`) for compatibility and
diagnostics. Normal UI read models use `card_kind`, not `block_type`.

### Функции

```rust
upsert_block(conn: &Connection, block: &Block) -> Result<i64>
remove_block(conn: &Connection, slug: &str) -> Result<bool>
get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>>
list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>>
list_blocks_light(conn: &Connection) -> Result<Vec<LightBlock>>
list_grid_blocks(conn: &Connection, tag: Option<&str>, offset: usize, limit: usize) -> Result<(Vec<LightBlock>, bool)>
list_grid_blocks_with_query(conn: &Connection, tag: Option<&str>, offset: usize, limit: usize, query: Option<&str>) -> Result<(Vec<LightBlock>, bool)>
list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<IndexedBlock>>
get_all_tags(conn: &Connection) -> Result<Vec<TagCount>>
slug_exists(conn: &Connection, slug: &str) -> Result<bool>
resolve_unique_slug(conn: &Connection, raw_slug: &str) -> Result<String>
rename_slug(conn: &Connection, old_slug: &str, new_slug: &str) -> Result<bool>
sync_thumb_metadata(conn: &Connection, slug: &str, thumb_path: &Path, vault_root: Option<&Path>) -> Result<bool>
clear_thumb_metadata(conn: &Connection, slug: &str) -> Result<bool>
backfill_missing_thumb_metadata(conn: &Connection, vault: &VaultLayout) -> Result<usize>
list_preview_blocks(conn: &Connection, limit: usize) -> Result<Vec<PreviewBlock>>
list_preview_blocks_by_tag(conn: &Connection, limit: usize) -> Result<Vec<(String, Vec<PreviewBlock>)>>
list_pending_thumb_upgrade_blocks(conn: &Connection) -> Result<Vec<PendingThumbUpgradeBlock>>
search_blocks(conn: &Connection, query: &SearchQuery) -> Result<Vec<IndexedBlock>>
upsert_channel(conn: &Connection, channel: &Channel) -> Result<i64>
list_channels(conn: &Connection) -> Result<Vec<Channel>>
next_channel_position(conn: &Connection) -> Result<u32>
remove_channel(conn: &Connection, tag: &str) -> Result<bool>
```

### Поведение upsert_block

- Если блок с таким slug уже есть — обновляет все поля
- Пересчитывает и сохраняет `body_hash` (body после frontmatter) для external rename detection
- Обновляет block_tags: удаляет старые, вставляет новые
- Обновляет wikilinks: удаляет старые, вставляет новые (из extract_wikilinks)
- FTS5 обновляется автоматически через триггеры
- Не генерирует thumbnail и не угадывает `thumb_format` по slug. Thumbnail
  metadata синхронизируется отдельным `sync_thumb_metadata` после записи thumb.

### Поведение thumbnail metadata / preview queries

- `sync_thumb_metadata` читает on-disk thumb magic bytes и mtime, затем пишет
  `thumb_format = jpeg|png` и `thumb_mtime`; если файл отсутствует или не
  является валидным JPEG/PNG, поля очищаются.
- `list_preview_blocks` и `list_preview_blocks_by_tag` возвращают только
  non-channel rows с `thumb_format IS NOT NULL`. Отсутствующий thumb не должен
  превращаться в пустую sidebar preview-card.
- `backfill_missing_thumb_metadata` восстанавливает metadata для legacy rows,
  у которых thumb file уже лежит на диске, но SQLite columns ещё пустые.
- `list_pending_thumb_upgrade_blocks` отдаёт кандидатов для Phase 2 upgrade,
  включая PNG placeholder rows и rows с missing/NULL metadata; command layer
  обязан проверить реальный disk state перед возвратом upgrade request.

### Поведение rename_slug

- Меняет только `blocks.slug` в SQLite-индексе
- Не делает silent conflict resolution: target slug должен быть свободен
- Не переписывает другие `.md` файлы и не трогает source vault
- Используется как low-level primitive для watcher-based external rename; in-app rename поверх него дополнительно переписывает vault refs и source media

### Поведение list_channels / next_channel_position

- `list_channels` возвращает каналы в порядке `position ASC`, затем стабильный
  `CollectionRef` tie-breaker. Legacy DB column `channels.title` is not a
  display-title source.
- `next_channel_position` возвращает `max(position) + 1`, либо `0` для пустого списка.
- Новые каналы должны получать append-position через `next_channel_position`; `position = 0` допустим только для первого канала или explicit reorder.

The implementation still uses `channels.tag` and `block_tags.tag` physical
column names for compatibility, but their semantic value is now
`CollectionRef`: the Obsidian wikilink target stored in `Mine Collections`, not
a normalized tag. Legacy normalized values are migration inputs only.

### Collection filenames

- Collection pages are `.md` files with `type: channel`.
- Canonical source format uses human-readable filenames:
  `Красивый веб.md`, not `красивый-веб.md`.
- Channel `title` may mirror filename for display, but it is not a machine id.
- Watcher must not canonicalize collection filenames by lowercasing,
  kebab-casing, or tag-normalizing them.
- Legacy normalized channel files are migration inputs. The
  `migrate-collections-to-wikilinks` tool may rename them to human filenames
  after dry-run, backup, and conflict checks.
- If a target human filename already exists and differs materially, migration
  must stop and report the conflict instead of deleting or merging files.
- Ordinary Obsidian/article/image/link files with human filenames are never
  canonicalized.

### Поведение search_blocks

- Свободный текст: `WHERE blocks_fts MATCH ?`
- Фильтр type/card kind: against derived runtime card kind, not raw
  `frontmatter.type`
- Фильтр tag: `JOIN block_tags WHERE tag = ?`
- Комбинация: AND между фильтрами

### Поведение Grid search

Surface Search не возвращает отдельный `IndexedBlock` result set в frontend.
Main/Grid search расширяет route-facing `list_grid_blocks`:

- `query` пустой — текущий route path, `ORDER BY saved_at DESC`;
- `query` непустой — `JOIN blocks_fts`, optional collection `JOIN block_tags`,
  `WHERE blocks_fts MATCH ?`;
- ranking: `ORDER BY bm25(blocks_fts, 8.0, 3.0, 1.0) ASC, b.saved_at DESC`;
- projection остаётся lightweight `LightBlock`, без полного body payload для
  media cards и без per-block tags;
- search excerpt/highlight metadata строится только для возвращаемых rows;
- FTS columns: `title` = `display_title` + legacy `title` + `fallback_label`,
  `description`, `body`.
- derived `search_chunks` дополнительно содержат searchable metadata fields:
  `author` и `url`. Эти chunks участвуют в lexical/fuzzy candidate generation
  и ranking, но не считаются visible highlight surfaces.

Hybrid behavior:

- lexical/alias candidates and semantic candidates are collected behind one
  storage-level `SearchEngine` boundary;
- non-empty Grid queries delegate to `storage::search_engine`;
- lexical and alias candidates use SQLite FTS5, with deterministic
  aliases/transliteration before matching;
- fuzzy candidates use normalized `search_chunks` and real text ranges;
- semantic candidates use persisted `search_embeddings` generated by local
  `fastembed` `intfloat/multilingual-e5-small`;
- model files are cached outside the project tree at
  `~/Library/Application Support/com.mine.app/cache/fastembed` by default, with
  `FASTEMBED_CACHE_DIR` as the explicit override;
- single-token Latin queries bypass semantic embedding work and do not admit
  semantic-only rows into Grid results; semantic-only rows are reserved for
  Cyrillic cross-language queries and multi-token semantic queries;
- collection route filtering is applied before final projection;
- candidate chunks collapse to one card result per slug;
- exact/prefix/alias matches carry real highlight ranges;
- author/url metadata matches carry empty highlight ranges; author can explain
  why a card matched, but URL remains hidden in card rendering;
- semantic-only matches carry an excerpt and empty highlight ranges;
- embedding generation is background derived work after vault open; non-empty
  search never downloads the model or generates missing vectors in the
  foreground, and falls back to lexical/alias/fuzzy while semantic state warms.

Полный surface contract: [SPEC_SEARCH.md](SPEC_SEARCH.md).

---

## storage/vault_stats

Источник данных для main secondary statistics bar. Это read-model snapshot для
UI chrome, а не analytics subsystem: он должен быть быстрым, детерминированным
и обновляться после каждого изменения vault/index state.

### Типы

```rust
struct VaultStats {
    markdown_file_count: u64,
    media_file_count: u64,
    source_bytes: u64,
    current_collection_card_count: u64,
    current_collection: Option<String>, // None means Everything
    updated_at_ms: u64,
}
```

### Функции

```rust
get_vault_stats(conn: &Connection, vault: &VaultLayout, current_collection: Option<&str>) -> Result<VaultStats>
count_current_collection_cards(conn: &Connection, current_collection: Option<&str>) -> Result<u64>
scan_source_vault_file_stats(vault: &VaultLayout) -> Result<SourceVaultFileStats>
```

### Поведение source vault stats

- `markdown_file_count` считает физические `.md` файлы в source vault
  рекурсивно, включая collection pages и ordinary Obsidian notes.
- `media_file_count` считает физические source assets, которые не являются
  `.md` файлами: images, video, audio, PDF/other local files. Derived artifacts
  приложения не входят.
- `source_bytes` — сумма byte size всех файлов, вошедших в
  `markdown_file_count` и `media_file_count`. Это размер source vault, не
  `Application Support`, не thumbnails, не semantic model cache и не
  audio/cache.
- Hidden/service directories исключаются тем же правилом, что `scan_md_files`:
  `.arena/`, `.obsidian/`, `.trash/`, `.git/`, `node_modules/`, `target/`,
  `__pycache__/`.
- Symlink traversal за пределы vault запрещён. Symlink-файлы внутри vault можно
  считать как сам symlink metadata entry, но нельзя следовать наружу и
  прибавлять внешний каталог.

### Поведение collection card count

- `current_collection = None` (`Everything`) считает все indexed rows, где
  `card_kind != channel`.
- `Some(collection_ref)` считает indexed non-channel rows, связанные с этим
  `CollectionRef` через `block_tags`.
- Surface/Grid search query не влияет на `current_collection_card_count`.
- Count строится из SQLite read-model, а не из текущего frontend массива
  карточек, чтобы virtualized/paginated Grid не становился источником истины.

### Realtime contract

- `get_vault_stats` возвращает complete snapshot; frontend не применяет
  increments и не считает статистику из текущего Grid массива.
- После in-app commands, меняющих source files, media files, membership,
  channels или index rows, существующие grid/taxonomy/vault invalidation events
  являются сигналом заново вызвать `get_vault_stats` для текущего route scope.
- Допустима frontend-коалесценция нескольких invalidation событий в один
  snapshot через animation frame. Видимой задержки ради debounce быть не
  должно: UI chrome должен обновиться в тот же пользовательский цикл, в котором
  обновляется Grid/Sidebar.
- Если backend позже публикует отдельный `vault:stats-updated`, event payload
  должен быть complete `VaultStats` snapshot, не delta.
- Initial load вызывает `get_vault_stats` один раз после vault open/index
  readiness. До первого snapshot frontend показывает пустую fixed-height
  statistics row, а не placeholder text.

---

## storage/files

Файловые операции: создание/чтение/удаление блоков и медиафайлов в vault.

### Функции

```rust
write_block_file(vault: &VaultLayout, block: &Block) -> Result<PathBuf>
read_block_file(vault: &VaultLayout, path: &Path) -> Result<(String, String)>  // (vault-relative slug, content)
scan_md_files(vault: &VaultLayout) -> Result<Vec<PathBuf>>
copy_media_file(source: &Path, vault: &VaultLayout, slug: &str) -> Result<PathBuf>
delete_user_file(path: &Path) -> Result<()>
delete_block_files(vault: &VaultLayout, slug: &str, media_ext: Option<&str>) -> Result<()>
delete_block_files_with_media_paths(vault: &VaultLayout, slug: &str, media_paths: &[PathBuf]) -> Result<()>
persist_new_block(conn: &Connection, vault: &VaultLayout, block: &Block, source_file: Option<&Path>) -> Result<IndexedBlock>
persist_new_reference_block(conn: &Connection, vault: &VaultLayout, block: &Block) -> Result<IndexedBlock>
rename_derived_artifacts(vault: &VaultLayout, old_slug: &str, new_slug: &str) -> Result<()>
```

### Поведение write_block_file

- Сериализует Block через domain::block::serialize_block
- Записывает в `vault/slug.md`
- Создаёт директории при необходимости
- `slug` должен приходить из `domain::block::suggest_slug`: human-readable Unicode stem, NFC-normalized, bounded by `100` chars и `220` NFD bytes. Storage не должен повторно обрезать имя или строить media path из legacy title: source media references берутся из `frontmatter.file`.
- New writes serialize `frontmatter.file` as an Obsidian wikilink string
  (`file: "[[name.ext]]"`). Legacy raw `file: name.ext` remains accepted on
  read and is normalized in the indexed read model.

### Поведение scan_md_files

- Возвращает пути всех `.md` файлов в vault recursively.
- Игнорирует hidden/service/build директории: `.arena/`, `.obsidian/`,
  `.trash/`, `.git/`, `node_modules/`, `target/`, `__pycache__/`.
- Игнорирует файлы, не являющиеся `.md`
- NFC-normalizes filename boundary перед возвратом в indexing/watcher pipeline

### Поведение delete_block_files

- User-owned source files удаляются через OS Trash, с fallback на `remove_file` для iCloud placeholder/failure случаев.
- `delete_block_files` сохраняет legacy contract: удаляет `.md`, slug-owned primary media `<slug>.<ext>` и derived thumbnail.
- `delete_block_files_with_media_paths` получает уже проверенный higher-level deletion plan и удаляет `.md`, перечисленные media paths и derived thumbnail.
- Shared/orphan решение не принимается в storage layer; оно принадлежит `commands::blocks::prepare_delete_block`.

### Поведение media reference resolution

- `storage::media_refs` is the single backend resolver for local media
  references used by index, thumbnails, media dimensions, thumb upgrades, and
  inline-media extraction.
- `frontmatter.file` accepts canonical `[[name.ext]]` and legacy raw
  `name.ext`; both resolve through the same frontmatter media resolver.
- `![alt](path)` follows Markdown semantics: `path` is note-relative only.
- `![[name.ext]]` follows Obsidian attachment semantics: same-directory path
  first, then basename lookup through the vault, excluding hidden/service/build
  dirs.
- `![[folder/name.ext]]` uses the explicit path, checked note-relative and then
  vault-root-relative.
- Derived DB fields store resolved vault-root-relative paths when the file is
  found. Source Markdown is not rewritten on read.

### Поведение rename_derived_artifacts

- Переименовывает только local derived artifacts, не source vault:
  - block-level thumbnail `thumbs/<slug>.jpg`
    - stable path/key; file content may be JPEG or PNG
    - app `asset://` protocol must serve MIME by magic bytes, not extension
  - article audio artifacts и sidecar через `storage::article_audio::rename_all_artifacts`
- Используется и watcher external rename path, и explicit in-app rename command
- Если higher-level rename flow меняет speakable article text, audio может быть дополнительно инвалидирован поверх этого helper'а

### Поведение persist_new_reference_block

- Записывает только новый `.md` файл.
- Не копирует media-файл и не объявляет новый блок владельцем `frontmatter.file`.
- Генерирует thumbnail через общий `generate_for_block`, то есть из уже существующего файла, на который указывает `frontmatter.file`.
- Индексирует блок и синхронизирует thumbnail metadata так же, как `persist_new_block`.
- Используется для inline-media extraction: новый media-card копирует ссылку
  на media из исходной статьи, а не бинарный файл, и пишет empty body. Source
  article body is not changed.
- Will be used for text-selection extraction: новый article-блок копирует
  selected text snapshot и related-note reference; media copy не выполняется.

### Text selection extraction storage contract

Text-selection extraction writes two source-vault files in the successful path:

1. Source article `.md`: patched only if the first selected Markdown block lacks
   a native Obsidian block id.
2. New excerpt card `.md`: normal Mine article block with `Mine Collections`,
   `Mine Related Notes: [[Source#^block-id]]`, and snapshot body.

Storage rules:

- Source patch must preserve every byte outside the inserted ` ^block-id`
  suffix.
- Source patch must not add frontmatter, sidecar metadata, hidden comments, or
  backlinks.
- New excerpt card does not own any media file and must not influence media
  cleanup planning.
- Thumbnail generation for the new excerpt uses the normal text-thumbnail path.
- Relationship indexing must preserve the full block-reference target for
  display/opening and expose the base note target for existence checks and
  rename rewrite.
- In-app rename of a source note must rewrite `[[Old#^id]]` to `[[New#^id]]`
  in body wikilinks and in `Mine Related Notes`.

---

## storage/thumbnails

Генерация превью: resize для изображений, text-to-image для статей, unified cascade через `generate_for_block`.

> **Note**: Этот раздел описывает Rust-side API модуля `storage/thumbnails`. Полная архитектура thumbnail pipeline (включая WebView upgrade path, event flow, Phase 1/Phase 2 разделение) — в [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md). Следующие функции — это building blocks, вызываемые из shared dispatch `generate_for_block`.

### Функции

```rust
generate_thumbnail(source: &Path, dest: &Path, max_size: u32) -> Result<(u32, u32)>
generate_text_thumbnail(display_title: Option<&str>, body: &str, dest: &Path) -> Result<(u32, u32)>
is_thumb_fresh(thumb_path: &Path, source_path: &Path) -> bool
generate_for_block(block: &Block, vault: &VaultLayout) -> ThumbSource
is_image_ext(ext: &str) -> bool
is_video_ext(ext: &str) -> bool
```

### Поведение — generate_thumbnail (изображения)

- Читает исходное изображение (JPEG, PNG, WebP, GIF)
- Ресайз с сохранением пропорций: макс. сторона = `max_size` (по умолчанию 480px, 2x Retina)
- Сохраняет как JPEG (quality 85)
- Возвращает (width, height) результата
- Если изображение меньше max_size — сохраняет как есть (без увеличения)

### Поведение — generate_text_thumbnail (статьи и media placeholder)

- Создаёт PNG 480x480 с прозрачным фоном для theme-adaptive rendering
- Рисует заголовок (шрифт 1.3x, цвет #333) и тело статьи (шрифт 24px, цвет #505050)
- Очищает markdown: заголовки, жирный/курсив, ссылки `[text](url)` → text
- Word-wrap по ширине с учётом метрик шрифта
- Шрифт: Geist Regular (Latin + Cyrillic), встроен через `include_bytes!`, парсится один раз через `LazyLock<FontArc>`

### Поведение — is_thumb_fresh (проверка свежести)

- Сравнивает mtime миниатюры и исходного файла
- **Дополнительно валидирует magic bytes** thumb-файла: первые 3 байта должны матчить `FF D8 FF` (JPEG) или `89 50 4E` (PNG). Файлы с другим content считаются не fresh и force regenerate — защита от legacy state, где text PNG оставались под `.jpg` расширением forever
- Возвращает `true` если миниатюра существует, свежая по mtime, и имеет валидное image content
- Используется в `full_scan` и `index_md_file` для пропуска избыточной генерации

### Поведение — generate_for_block (unified cascade)

Единая точка входа для thumbnail generation. Вызывается и из native host (Phase 1 at save time), и из watcher handler (full_scan, index_md_file). Cascade с graceful fallback chain:

1. `frontmatter.file` указывает на existing image → `generate_thumbnail`
   (`file` may be canonical `[[...]]` or legacy raw syntax on read)
2. `frontmatter.file` указывает на existing video → `generate_video_thumbnail` (с fallback к text при ошибке)
3. `frontmatter.thumbnail` field указывает на existing image → `generate_thumbnail`
4. First existing local embedded media in body (`![[local_file]]`, `![[local_file|alt]]`, legacy `![](local_file)`) in markdown order:
   - если первым идёт video → `generate_video_thumbnail` (с fallback через дальнейший article media cascade)
   - если первым идёт image → multi-image composite / `generate_thumbnail`
5. Later body media fallback:
   - usable article images → composite или single-image thumbnail
   - first local video → `generate_video_thumbnail` (с fallback к text при ошибке)
6. Media-bearing blocks whose source exists but cannot be decoded by Rust
   (AVIF, HEIC, VP8X WebP, unsupported video) → `generate_text_thumbnail` with
   `display_title` or `fallback_label`. Empty-body media clips intentionally do
   not synthesize `frontmatter.title`, so `fallback_label` is required.
7. Runtime card kind is `article` → `generate_text_thumbnail` (всегда успешно)

Для inline video `preview_manifest.tiles[].preview_path` не должен указывать
на derived `<video-stem>.jpg`, пока такой per-video thumbnail реально не
создаётся. Video tiles используют block-level `<slug>.jpg` poster fallback.

Возвращает `ThumbSource` enum (`Image | Video | Text | None`) для telemetry и определения необходимости WebView upgrade (см. SPEC_THUMBNAILS.md Phase 2).

### Поведение — is_image_ext / is_video_ext

Предикаты расширений для dispatching. Признаки `storage::thumbnails` как single source of truth:
- `is_image_ext`: `jpg | jpeg | png | gif | webp | bmp | tiff | tif`
- `is_video_ext`: `mp4 | webm | mov`

Note: эти предикаты описывают **что pipeline пытается decode**, не что на 100% работает. WebP и некоторые video форматы могут фейлить в Rust decode и fall back в text placeholder или WebView upgrade.

### Оптимизации

- **O1 — пропуск свежих**: `is_thumb_fresh()` перед каждой генерацией
- **O2 — LazyLock**: шрифт парсится один раз за время жизни процесса
- **O3 — фоновая генерация**: `full_scan()` индексирует синхронно, миниатюры генерирует в потоке `thumb-gen`, по завершении вызывает `on_thumbs_done` callback
