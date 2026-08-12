# SPEC: storage layer

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md)

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
    card_kind TEXT NOT NULL DEFAULT 'media', -- derived runtime kind: article/media/link/channel
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

-- Filesystem freshness state shared by cards and collection pages.
CREATE TABLE source_index_state (
    slug TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL, -- block | channel
    source_stamp TEXT NOT NULL, -- JSON SourceStamp
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

FTS5 синхронизируется через триггеры (INSERT/DELETE/UPDATE на blocks) и
остаётся текущим lexical backend. Целевой Search contract добавляет
rebuildable derived stores для alias/transliteration и semantic chunks/
embeddings в local app data store; пользовательские `.md` файлы не
переписываются ради поиска.
Every read-write `open_or_create` runs schema/trigger migration inside one
`BEGIN IMMEDIATE` transaction. Concurrent startup workers or native-host/app
connections wait on SQLite's busy timeout instead of interleaving
`DROP TRIGGER` / `CREATE TRIGGER`; a failed migration rolls back before the
connection is returned.

### Versioned migration contract

- `PRAGMA user_version` is the only authoritative schema version. The current
  version is owned by `storage/migrations.rs`; `storage/db.rs` owns connection
  pragmas and delegates all schema evolution to that module.
- An unversioned legacy database is version `0`. Migrations run strictly in
  sequence (`V0 -> V1 -> V2`) under one `BEGIN IMMEDIATE` transaction and
  persist `user_version` after every successful step.
- Every open validates required tables, typed columns, indexes, triggers and
  singleton rows after migration. A future version or incompatible drift is an
  explicit error; it is never interpreted as an already-applied migration.
- No `ALTER TABLE` error may be discarded. On any migration or validation
  failure the transaction rolls back, including the schema version update.
- Upgrade tests cover fresh creation, representative unversioned data, V1
  search data, malformed legacy schema, future versions and concurrent opens.
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
- `PRAGMA busy_timeout = 5000;` — bounded wait вместо immediate SQLITE_BUSY

---

## storage/index

Индексирование блоков в SQLite. Преобразование domain::Block в строки БД.

### Типы

```rust
struct IndexedBlock {
    id: i64,
    slug: String,
    block_type: BlockType, // legacy frontmatter.type
    card_kind: CardKind, // derived source of truth for feed/detail/search
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
    card_kind: CardKind, // derived source of truth for feed/detail/search
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

## storage/reconcile — filesystem-first visibility

Status: implemented in Phase A1 and consumed by Phase A3. Route-facing final
reads join the coalesced reconciler before querying SQLite; the same persisted
source stamps drive derived-preview invalidation.

`VaultReconciler` is the only storage primitive allowed to claim that the local
derived index reflects the current source vault. It compares a metadata-only
filesystem inventory with persisted `SourceStamp` values and performs an
incremental transaction. `full_scan` and route catch-up must delegate to this
primitive instead of maintaining two reconciliation algorithms.

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    mtime_ns: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DependencyStamp {
    vault_relative_path: String,
    file: Option<FileStamp>, // None means the referenced file is missing
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SourceStamp {
    markdown: FileStamp,
    dependencies: Vec<DependencyStamp>, // sorted, unique, vault-relative
}

struct ReconcileReport {
    inventory_markdown: usize,
    unchanged: usize,
    upserted: Vec<String>,
    removed: Vec<String>,
    dependency_changed: Vec<String>,
    errors: Vec<ReconcileFileError>,
    content_reads: usize,
    database_writes: usize,
    elapsed_ms: u64,
}

fn reconcile_vault(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<ReconcileReport, ReconcileError>;
```

### Source stamp rules

- Markdown stamp is `mtime_ns + size`; content hashing is not part of the warm
  inventory path.
- Dependencies are every resolved local source asset that can affect card
  projection or derived previews: canonical `file`, thumbnail source, body
  embeds and ordered `media_urls` sources.
- Dependency paths are normalized vault-relative paths. Absolute paths,
  symlink escapes and service directories are rejected.
- An unchanged Markdown stamp permits dependency comparison without reading or
  parsing Markdown because the previous dependency list is persisted inside
  `source_stamp`.
- A changed/missing stamp reparses only that source file, recomputes its
  dependencies and updates index/search projection in the same transaction.
- A missing `.md` removes the corresponding block/channel row and rebuildable
  derived artifacts. User media is never deleted by reconciliation.
- A malformed file does not make the report `fresh`: the last-good row is
  retained for recovery, the report carries a typed file error and the
  coordinator publishes `degraded`. This report is diagnostic and must not
  prevent unrelated route rows from being returned.

### Error contract

```rust
enum ReconcileError {
    Inventory { path: PathBuf, source: anyhow::Error },
    State { source: anyhow::Error },
    Commit { source: anyhow::Error },
}

enum ReconcileFileErrorKind {
    Metadata,
    Read,
    Parse,
    Index,
    DependencyOutsideVault,
}
```

Fatal inventory/database errors roll back the pass. Per-file errors are
collected, do not prevent unrelated valid files from being reconciled, and
prevent a false `fresh` state.

### Performance budgets

- Complexity: `O(N + D)` metadata calls for `N` Markdown files and persisted
  dependency entries, and `O(delta)` content reads/parses/upserts.
- An unchanged pass performs zero Markdown/media content reads and zero SQLite
  writes.
- Eight concurrent route-facing reads for one vault produce one inventory pass,
  not eight passes.
- One hundred sequential route reads on a clean coordinator generation produce
  zero additional inventory passes. A safety audit may run in the background,
  but no search keystroke waits for it.
- Release benchmark on the reference Apple Silicon machine: 10,000 unchanged
  Markdown entries complete in at most 500 ms; 100 changed notes in at most
  2,000 ms, excluding asynchronous thumbnail encoding.
- The report exposes counters and elapsed time so these budgets are assertions,
  not comments.

## storage/projection — committed generation contract

`FreshnessCoordinator::generation` identifies reconciliation work. It is not a
read-model identity and must never be used by the frontend as one. SQLite owns a
separate persisted `projection_generation` that identifies the exact committed
state visible to route reads.

```rust
struct ProjectionRevision(u64);

struct GridSnapshot {
    generation: ProjectionRevision,
    blocks: Vec<LightBlock>,
    total_blocks: usize,
    has_more: bool,
}

fn read_grid_snapshot(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<GridSnapshot>;
```

Rules:

- `blocks`, `channels`, `block_tags`, `source_index_state` and every
  preview/thumbnail column stored on a block are projection inputs.
  Insert/update/delete advances one monotonic SQLite generation inside the same
  transaction as that write. Multiple row writes in one source transaction may
  advance it more than once; only ordering and atomic visibility are semantic.
- Grid, taxonomy, sidebar previews and Graph expose the same typed
  `ProjectionRevision`. Each DTO reads its revision and all dependent queries
  through `read_projection_snapshot` inside one SQLite savepoint. A concurrent
  writer is therefore observed either entirely before or entirely after the
  snapshot, never between its fields.
- A preview manifest is route-visible when `preview_state = ready`, and also
  when it is `stale` with a non-null `preview_source_stamp`. The second case is
  a preview that exists on disk and is merely marked for recomputation: every
  write to a block marks it, including one that edited only frontmatter tags,
  and the source stamp covers the whole `.md`. Withholding it turned connecting
  a card to a collection into minutes of a missing video, because the card fell
  back to text until the preview queue reached it. The cost of serving it is a
  poster one generation behind until reconciliation replaces it.
- A `stale` preview with a null stamp was never generated, so nothing exists to
  draw; it stays withheld, as do `missing` and `failed`. The stamp is what tells
  "not built yet" apart from "built, worth rechecking".
- Progressive preview batches are separate committed generations. The UI may
  replace generation `N` with `N + 1`; it must not merge rows/pages from two
  different generations or apply an older response after a newer one.
- Generation zero is a valid empty/new database snapshot. Generation identity
  is scoped to one vault-derived database; changing vault remounts the frontend
  owner and resets its accepted generation.
- Search carries the same projection revision and preview publication
  predicate, but has its own snapshot and independent search revision below.

### Search revision and cursor contract

```rust
struct SearchRevision(u64);

struct SearchPageToken {
    projection_revision: ProjectionRevision,
    search_revision: SearchRevision,
    offset: usize,
    query_fingerprint: String,
}

struct SearchSnapshot {
    generation: ProjectionRevision,
    search_generation: SearchRevision,
    blocks: Vec<LightBlock>,
    has_more: bool,
    next_cursor: Option<SearchPageToken>,
    cursor_reset: bool,
}
```

- `search_state.revision` advances on inserts, updates and deletes in
  `search_document_state`, `search_chunks` and `search_embeddings`; these
  derived writes do not pretend to be source projection changes.
- A page token is valid only when projection revision, search revision and the
  fingerprint of collection plus query all still match. Any mismatch resets to
  offset zero and returns `cursor_reset = true`.
- `SearchSnapshot` is read after search-document synchronization under the
  projection snapshot boundary, so ranking and pagination cannot silently mix
  two search-index states.

## storage/derived_preview — completion contract

Status: implemented in Phase A3. A single app-level background worker drains a
multi-vault coalescing queue; a full-vault request supersedes queued per-slug
work for that vault, while changes arriving during a pass are drained before the
worker exits.

The feed never infers readiness from a non-null `preview_manifest` alone. Every
manifest has an explicit derived state validated against the local cache.

```rust
enum DerivedPreviewState {
    Missing,
    Stale,
    Ready,
    Failed,
}

struct PreviewReconcileReport {
    checked: usize,
    ready: usize,
    regenerated: usize,
    changed_slugs: Vec<String>,
    failed: Vec<PreviewFailure>,
    cancelled: bool,
}

fn reconcile_preview_for_slug(
    conn: &Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<Option<PreviewReconcileOutcome>>;

fn reconcile_all_previews(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<PreviewReconcileReport>;
```

Rules:

- `Ready` means the manifest is semantically valid for the current `card_kind`,
  every required `primary_preview_path`/tile preview exists, stays inside the
  derived cache, is decodable by the receiving surface and matches the current
  `source_stamp`.
- `text` is a valid asset-free feed recipe for `article`, `link` and nonvisual
  file cards. It does not mount a bitmap panel. Visual image/video media cannot
  become `Ready` from a text placeholder; it remains a typed missing/failed
  state until its image/video/composite artifact exists.
- Missing cache files and changed dependency stamps transition to `Stale` and
  schedule regeneration; they never leave a manifest that lies about files.
- Source reindex marks the row `Stale` but preserves the previous
  `preview_source_stamp` until the new preview publishes. This lets the worker
  distinguish an actual dependency change from a legacy row whose stamp was
  never recorded.
- A legacy row with `preview_source_stamp = NULL` may adopt already-valid JPEG
  artifacts and stamp them without source decoding. A missing first tile for a
  non-composite single-media manifest may be materialized atomically from its
  valid primary preview.
- Backfill is resumable and idempotent. It updates SQLite only after all files
  for one manifest are durably renamed into place.
- Encoding failures preserve the last complete manifest when safe, publish a
  typed retryable/non-retryable error and never expose partial files.
- Grid/Card/measurement code consumes only `Ready` derived paths. Original
  source assets remain Detail-only.

Budgets:

- One app-level worker owns preview generation. It processes only the current
  vault, cancels obsolete work between blocks after a vault switch, and
  coalesces full-vault/per-slug requests rather than spawning competing
  decoders/writers.
- Full-pass batches are bounded to `24` blocks and yield between batches.
  Changed slugs are published to the frontend after each completed batch; UI
  readiness never waits for an entire large-vault pass.
- A warm validation pass performs metadata checks only and schedules zero
  decodes for `Ready` rows.
- Feed browser acceptance permits zero source-vault image/video requests during
  fast scroll; all requests must resolve inside the derived cache.
- A stale worker may publish `Ready` only if the persisted source stamp still
  equals the stamp it generated from; a compare-before-publish guard prevents an
  old encode from overwriting a newer invalidation.

## storage/cold_space_audit — disposable acceptance contract

Cold-space acceptance must exercise the same storage primitives as production
without writing to the source vault or trusting an existing local cache.

```rust
fn run_cold_space_audit(
    source_root: &Path,
    derived_base: &Path,
    cycles: usize,
) -> Result<ColdSpaceAuditReport>;
```

- `cycles >= 2`; one fresh store cannot prove cache-reset stability.
- `derived_base` must already exist, be empty and be neither inside
  `source_root` nor an ancestor of it. Each cycle owns a fresh
  `<derived_base>/cycle-N` store.
- Every source Markdown is classified exactly once as content, collection or a
  typed unsupported input. The audit rejects missing and stale extra
  projections instead of hiding them in aggregate counts.
- A cycle records three semantic snapshots: immediately after source
  reconciliation, after derived-preview completion, and after closing and
  reopening SQLite read-only.
- Each semantic snapshot also contains the exact production `GridSnapshot`
  DTO, including its persisted projection generation. This DTO is the fixture
  consumed by browser acceptance; tests must not recreate `LightBlock` rows in
  TypeScript.
- Snapshots include deterministic Grid order, source/projection counts,
  runtime card kinds, preview state/manifests and semantic/fallback violations;
  they exclude volatile row ids and timestamps.
- Grid pagination orders by `saved_at DESC`, then case-insensitive and binary
  slug ascending as deterministic tie-breakers. Rebuilds cannot depend on
  SQLite row insertion order when source timestamps are equal.
- Reopened state must equal settled state. Independent cold cycles must have
  equal first and settled snapshots, proving restart and derived-cache reset
  stability.
- Source file path, size and modification-time fingerprints are captured before
  and after every cycle. Any mutation fails the audit.
- Browser-decode-required and missing-source previews are typed non-ready
  outcomes, not audit infrastructure failures. Their cards still need a
  deterministic type-correct first-frame fallback.
- The browser gate creates a real temporary source vault, builds an empty
  derived SQLite store through Rust, serializes the production IPC DTO and
  renders that payload in Grid. This single path covers source files -> parser
  -> SQLite -> Rust serialization -> frontend DTO -> Grid.

## storage/source_mutation — atomicity contract

Compound user mutations are planned and committed through one storage-owned
boundary. Commands validate IPC and emit events; they do not sequence raw file
and SQL writes themselves.

```rust
enum SourceMutationKind {
    Create,
    Rewrite,
    Rename,
    Delete,
    ImportBlock,
}

enum SourceMutationError {
    Validate { path: PathBuf, reason: String },
    Stage { path: PathBuf, source: io::Error },
    CommitFile { path: PathBuf, source: io::Error },
    CommitIndex { operation: &'static str, source: rusqlite::Error },
    Rollback { original: Box<SourceMutationError>, failures: Vec<PathBuf> },
}
```

- New/replacement files use same-directory temp + file `fsync` + atomic rename;
  create-new additionally rejects an occupied destination before commit.
- Multi-file operations stage every new byte sequence before the first visible
  rename and retain byte backups until the SQLite transaction commits.
- A failure restores old source bytes and the previous index generation. If
  rollback itself is incomplete, the operation returns `Rollback` and forces
  freshness state to `degraded` so reconciliation runs before further reads.
- Derived artifacts are never part of the source transaction and may be
  regenerated after commit.

### Runtime/card kind derivation

Storage derives a semantic presentation kind from document evidence. Legacy
`frontmatter.type` is a compatibility hint only when the document shape is
otherwise ambiguous. During indexing:

1. `type: channel` derives `card_kind = channel`.
2. Any other block with non-empty body derives `article`.
3. An empty-body block with canonical `file` derives `media` even when its
   source asset is temporarily missing.
4. An empty-body block with URL/link metadata and no owned media derives `link`.
   This URL evidence takes precedence over a legacy `type: image | video |
   file` hint: a remote video bookmark is still a link card unless Mine owns a
   local `file`.
5. Without body, owned file or URL, a legacy `type: image | video | file` hint
   derives `media` for compatibility.
6. Any remaining ordinary/foreign Markdown derives `article`, including an
   empty note; absence of body is not evidence of media ownership.

The physical `block_type` column keeps the parsed legacy/source type
(`image`, `link`, `video`, `file`, `article`, `channel`) for compatibility and
diagnostics. Normal UI read models use `card_kind = article | media | link |
channel`, not `block_type`.

`card_kind` and preview kind are orthogonal: a link may have an image preview,
but remains a link. A link without a derived image renders its textual card and
Detail metadata without a faux media panel.

### Функции

```rust
upsert_block(conn: &Connection, block: &Block) -> Result<i64>
remove_block(conn: &Connection, slug: &str) -> Result<bool>
get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>>
list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>>
list_blocks_light(conn: &Connection) -> Result<Vec<LightBlock>>
list_grid_blocks(conn: &Connection, tag: Option<&str>, offset: usize, limit: usize) -> Result<(Vec<LightBlock>, bool)>
read_search_snapshot(conn: &Connection, tag: Option<&str>, query: &str, limit: usize, cursor: Option<&SearchPageToken>) -> Result<SearchSnapshot>
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
- Обновляет `wikilinks`: удаляет старые, вставляет только plain note links из
  `extract_note_wikilinks`. Media embeds `![[file]]` остаются в media pipeline
  и не попадают в block-to-block graph relation index.
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
Он использует отдельный route-facing `search_grid_blocks`, а обычный Grid
остаётся на `list_grid_blocks` без query-параметра:

- пустой overlay использует обычный vault-wide `list_grid_blocks` для recent;
- непустой query идёт через `search_grid_blocks`, optional collection filter,
  `WHERE blocks_fts MATCH ?`;
- ranking: `ORDER BY bm25(blocks_fts, 8.0, 3.0, 1.0) ASC, b.saved_at DESC`;
- projection остаётся lightweight `LightBlock`, без полного body payload для
  media cards и без per-block tags;
- search excerpt/highlight metadata строится только для возвращаемых rows;
- pagination uses `SearchPageToken`; raw offsets are not accepted for a
  continued search page;
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
- `total_file_count` считает тот же пользовательский content layer, что
  `markdown_file_count + media_file_count`; hidden/service/build директории не
  входят, чтобы main UI не смешивал source content и служебные файлы.
- `source_bytes` — сумма byte size всех файлов, вошедших в
  `markdown_file_count` и `media_file_count`. Это размер source vault, не
  `Application Support`, не thumbnails, не semantic model cache и не
  audio/cache.
- Hidden/service directories исключаются тем же правилом, что `scan_md_files`:
  `.mine/`, `.obsidian/`, `.trash/`, `.git/`, `node_modules/`, `target/`,
  `__pycache__/`; legacy `.arena/` также исключается и используется только как
  migration source.
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
- Игнорирует hidden/service/build директории: `.mine/`, `.obsidian/`,
  `.trash/`, `.git/`, `node_modules/`, `target/`, `__pycache__/`; legacy
  `.arena/` также игнорируется.
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
- Генерация article audio выключена (см. `SPEC_ARTICLE_AUDIO.md`), но
  обслуживание уже существующих артефактов — переименование, инвалидация,
  удаление вместе с блоком — остаётся скомпилированным намеренно: иначе аудио,
  созданное до отключения, зависло бы в derived store навсегда

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

### Поведение — generate_text_thumbnail (micro previews and text content)

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
6. Media-bearing blocks whose source cannot be decoded by Rust remain typed
   `browser_decode_required`/failed for the feed recipe. A text micro-preview may
   still exist for Sidebar diagnostics, but cannot satisfy media readiness.
7. Runtime card kind is `article` or `link` → text recipe; an optional micro
   thumbnail may be generated for compact Sidebar surfaces.

`storage::preview_plan::resolve_upgrade_media` owns browser-upgrade source
selection. Watcher and `list_pending_thumb_upgrades` pass the same indexed
`PreviewUpgradeInput` (`media_file`, `thumbnail`, ordered `media_urls`, then
legacy `first_image`) and cannot maintain independent cascades. Derived-preview
reconciliation separately validates `card_kind + block_type + media_file`
against the persisted manifest before it may publish `Ready`.

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
