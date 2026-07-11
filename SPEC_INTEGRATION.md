# SPEC: integration layer (watcher + commands)

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md)

Связующий слой: file watcher отслеживает изменения в vault, Tauri commands предоставляют API для фронтенда. Оркестрация файл → парсинг → индексация → thumbnail.

Status: Phase A2 implemented. Watcher remains the low-latency invalidation
source; `VaultReconciler` is the correctness boundary, watcher recovery replaces
a failed native watcher, and compound source/index mutations use the
storage-owned staged commit/rollback contract from [SPEC_STORAGE.md](SPEC_STORAGE.md).

---

## watcher/events

Классификация событий файловой системы.

### Типы

```rust
enum VaultEvent {
    BlockChanged(PathBuf),   // .md создан или изменён
    BlockDeleted(PathBuf),   // .md удалён
    MediaChanged(PathBuf),   // медиафайл создан или изменён
    MediaDeleted(PathBuf),   // медиафайл удалён
}
```

### Функции

```rust
classify_notify_event(event: &notify::Event, vault: &VaultLayout) -> Vec<VaultEvent>
```

### Поведение classify_notify_event

- Принимает сырое событие `notify::Event`
- Игнорирует все hidden/service directories (`.mine`, `.obsidian`, `.git`,
  legacy `.arena`, `.mine-migration-backup`) и build/vendor directories such as
  `node_modules`, `target`, `__pycache__`
- Игнорирует директории
- `.md` файлы → `BlockChanged` / `BlockDeleted`
- Остальные файлы → `MediaChanged` / `MediaDeleted`
- Create/Modify → `*Changed`, Remove → `*Deleted`
- Перед dispatch watcher может отбросить event, если path временно находится в `AppState.suppressed_paths` (in-app rename suppresses its own write/rename burst)

---

## watcher/handler

Оркестрация: файловое событие → обновление индекса.

### Типы

```rust
struct ScanResult {
    pub indexed: usize,
    pub errors: usize,
}
```

### Функции

```rust
full_scan(conn: &Connection, vault: &VaultLayout) -> Result<ScanResult>
index_md_file(conn: &Connection, vault: &VaultLayout, path: &Path) -> Result<()>
handle_event(conn: &Connection, vault: &VaultLayout, event: &VaultEvent) -> Result<()>
```

### Поведение full_scan

- Production startup/route catch-up uses `VaultReconciler`; legacy
  `full_scan`/`incremental_scan` wrappers remain test-only compatibility helpers
  and delegate to the same reconciler rather than implementing a second scan.
- Reconciliation performs a metadata inventory, reads/parses only changed or
  missing-stamp Markdown, commits source-index changes transactionally and
  returns `ScanResult { indexed, errors }` from the typed report.
- Classic thumbnails and existence-backed derived previews are scheduled after
  the committed index generation; preview encoding is never part of the source
  transaction.
- Startup, rebuild and focus recovery use the same thumbnail-sweep coordinator.
  Same-vault requests coalesce, the latest switched vault replaces obsolete
  pending work, and a running sweep checks active-vault identity between jobs.

### Поведение index_md_file

- Читает файл, парсит блок, индексирует
- Генерирует thumbnail через `generate_for_block` в фоновом потоке
- Ошибки пробрасываются (не логируются)
- Эмитит Tauri event `block:added { slug, tags, is_text }` после успешного `upsert_block`
- Если `generate_for_block` вернул `ThumbSource::Text` но block имеет embedded media → эмитит `thumb:upgrade-requested { slug, media_path, kind }` для Phase 2 WebView upgrade (см. [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md))

### Поведение handle_event

- `BlockChanged` → `index_md_file`
- `BlockDeleted` → `storage::index::remove_block` (slug из имени файла) + Tauri event `block:removed { slug, tags }`
- `MediaChanged` → `storage::thumbnails::generate_thumbnail` для image media, эмитит `thumb:updated { slug }` по завершении. **Note:** текущий handler использует `path_to_slug(media_file)` который некорректен для articles с multiple inline images (slug ≠ media filename). См. SPEC_THUMBNAILS.md для правильного routing через block-aware lookup.
- `MediaDeleted` → удаление thumbnail
- External rename `.md` файла проходит через pending-remove queue + `body_hash` match (подробности в [SPEC_IDENTITY_ROBUSTNESS.md](SPEC_IDENTITY_ROBUSTNESS.md)): при match handler вызывает `storage::index::rename_slug`, переносит derived artifacts и эмитит `block:renamed { old_slug, new_slug }`. Другие `.md` файлы и source media не переписываются.

Watcher is a low-latency invalidation source, not the correctness boundary.
Missing/coalesced platform events are repaired by `VaultReconciler` before final
route-facing snapshots.

### Watcher recovery

- Native watcher errors emit `watcher-error` with vault path, consecutive error
  count and a stable error kind; errors are never log-only.
- Three consecutive callback/handler errors within 30 seconds schedule one
  coalesced reconciliation pass.
- A successful watcher event or reconciliation resets the consecutive counter.
- Recovery first completes one coalesced reconciliation, then starts a
  replacement native watcher and atomically swaps the single `AppState.watcher`
  slot. Dropping the previous handle stops it; no two watcher slots remain
  active.
- `watcher-error` and recovery events never contain source content.

### Tauri events (frontend subscribers)

Все события эмитятся через `tauri::Manager::emit`. Frontend subscribers в `src/hooks/useChannelPreviewsEvents.ts` и `src/hooks/useThumbnailUpgrade.ts`.

| Event | Payload | Emitted by |
|---|---|---|
| `block:added` | `{ slug: string, tags: string[], is_text: boolean }` | `index_md_file` после `upsert_block` |
| `block:removed` | `{ slug: string, tags: string[] }` | `handle_event::BlockDeleted` |
| `block:renamed` | `{ old_slug: string, new_slug: string }` | watcher external rename path и `rename_block_file` |
| `thumb:updated` | `{ slug: string }` | `save_thumb` command и фоновая генерация |
| `thumb:upgrade-requested` | `{ slug: string, media_path: string, kind: "image" \| "video" }` | `index_md_file` когда Rust cascade дал text placeholder для block с embedded media |

## commands/freshness coordinator

Status: implemented in Phase A1. The coordinator owns one reconciliation
generation per vault, exposes typed degraded/failure results and emits one
`vault-freshness-changed` diagnostic event for each leader generation.

```rust
enum VaultFreshnessState {
    Fresh { generation: u64 },
    Reconciling { previous_generation: u64 },
    Degraded { generation: u64, error_count: usize },
}

struct VaultFreshnessSnapshot {
    vault_path: String,
    state: VaultFreshnessState,
    last_report: Option<ReconcileReportSummary>,
}
```

The coordinator owns one in-flight `VaultReconciler` pass per vault. Calls that
arrive while it is running join the same generation and wait for the same
result. They must not queue another inventory scan immediately afterward.

### Route-facing read sequence

The following commands use one shared helper before their final query:
`list_grid_blocks`, `list_tags`, `list_channels`, `list_channel_previews`,
`search`, `get_block`, `get_vault_stats`, and `list_graph_snapshot`.

1. Capture vault identity/path without retaining `vault_state` mutex ownership.
2. Join or start reconciliation on a dedicated writable SQLite connection.
3. On `fresh`, open/read the committed generation and return the final snapshot.
4. On `degraded`, return a typed freshness error alongside any explicitly
   provisional cached frontend snapshot; never label stale data as fresh.

The frontend may paint a route-cache snapshot immediately during
`reconciling`, but it is provisional. Completion emits
`vault-freshness-changed`; Grid, Search, Detail, Sidebar and Graph replace the
provisional data from their existing route commands.

### Lock order

- Never wait for reconciliation while holding `vault_state`, `watcher`,
  `sync_tracker`, `suppressed_paths` or thumbnail sweep locks.
- Coordinator state is acquired only to join/start/finish a generation; no
  filesystem or SQLite work runs while that mutex is held.
- Reconciliation uses a dedicated DB connection and owns its SQLite transaction
  only after all AppState locks are released.
- Command-driven source writes finish/roll back before publishing dirty state;
  watcher suppression is registered before the first filesystem mutation.

### Performance and observability

- One route burst maps to one reconciliation generation.
- Provisional cache paint is not delayed by reconciliation.
- Final refresh emits once per generation, not once per changed file.
- Development diagnostics expose generation, joined callers, inventory count,
  parsed count, write count, errors and elapsed time.

---

## commands/state

Разделяемое состояние приложения.

### Типы

```rust
struct VaultState {
    conn: Connection,
    vault: VaultLayout,
}

struct AppState {
    vault_state: Mutex<Option<VaultState>>,
    suppressed_paths: Mutex<...>,
}

#[derive(Debug, Error, Serialize)]
enum CommandError {
    NoVault,
    Internal(String),
}
```

### Поведение AppState

- `suppressed_paths` — short-lived path suppression map для command-initiated file rewrites
- `suppress_paths(paths, ttl)` — регистрирует paths, которые watcher должен игнорировать в ближайшее TTL-окно
- Используется in-app rename, чтобы `.md` rewrite + source file rename не race'или с watcher external-rename logic

---

## commands/vault

```rust
#[tauri::command] select_vault(app, state, path: String) -> Result<VaultOpenResult, CommandError>
#[tauri::command] get_vault_path(state) -> Result<Option<String>, CommandError>
```

### Поведение select_vault

1. Resolve `.mine/vault-id`, migrate known legacy `.arena` identity once and
   remove known legacy derived artifacts from the source vault.
2. Create/open the per-device derived store under Application Support
   (`index.db`, `cache/thumbs`, `cache/audio`), never inside the source vault.
3. Expand asset scope, open the local SQLite snapshot and start exactly one
   native watcher.
4. Publish `VaultState` and return `VaultOpenResult` immediately with cached
   counts plus `sync_in_progress`/migration state.
5. Schedule background reconciliation, classic thumbnail sweep and derived
   preview work through their shared app-level coordinators. Dirty events
   arriving during sync coalesce into another pass; switching vaults cancels
   the previous vault between jobs and suppresses its stale completion events.
6. Emit `vault-sync-started` / `vault-sync-finished`; route-facing commands also
   join `ensure_vault_fresh`, so a missed startup event cannot leave stale final
   reads.

---

## commands/blocks

```rust
#[tauri::command] list_blocks(state) -> Result<Vec<IndexedBlock>, CommandError>
#[tauri::command] list_grid_blocks(state, current_tag: Option<String>, offset: Option<usize>, limit: Option<usize>, query: Option<String>) -> Result<GridSnapshot, CommandError>
#[tauri::command] get_block(state, slug: String) -> Result<Option<IndexedBlock>, CommandError>
#[tauri::command] create_block(state, ...) -> Result<IndexedBlock, CommandError>
#[tauri::command] extract_text_selection(state, ...) -> Result<IndexedBlock, TextSelectionExtractError>
#[tauri::command] prepare_delete_block(state, slug: String) -> Result<DeleteBlockPlan, CommandError>
#[tauri::command] delete_block(state, slug: String, delete_unused_media: Option<bool>) -> Result<bool, CommandError>
#[tauri::command] prepare_delete_blocks(state, slugs: Vec<String>) -> Result<DeleteBlocksPlan, CommandError>
#[tauri::command] delete_blocks(state, slugs: Vec<String>, delete_unused_media: bool) -> Result<bool, CommandError>
#[tauri::command] merge_blocks(state, ordered_slugs: Vec<String>) -> Result<MergeBlocksResult, MergeBlocksError>
#[tauri::command] rename_block_file(state, old_slug: String, new_stem: String) -> Result<RenameBlockResult, RenameBlockError>
```

### Поведение create_block

1. Сгенерировать slug из first body H1 / readable seed / url, without
   synthesizing `frontmatter.title`
2. Разрешить конфликт slug по SQLite и фактическим файлам vault (`.md` и
   optional media target); disk-only collisions не перезаписываются
3. Создать `Block` с frontmatter
4. Проверить и нормализовать collection refs на IPC-границе
5. Скопировать медиафайл create-new semantics (если есть)
6. Записать `.md` файл create-new semantics; если запись падает после media
   copy, удалить только что скопированный media файл
7. Сгенерировать thumbnail (если изображение)
8. Проиндексировать
9. Вернуть `IndexedBlock`

### Поведение vault conflict resolution

`resolve_vault_conflict(base_slug, conflict_slug, action)` принимает только
валидные slugs и выполняет файловые операции только если exact pair всё ещё
существует в `vault_conflicts`. Команда не является произвольным
rename/delete API: stale или несуществующая conflict-запись должна вернуть
ошибку без изменения файлов.

Incremental scan обязан обрабатывать iCloud-style conflict filenames так же,
как full scan: conflict file записывается в `vault_conflicts` и не индексируется
как обычный блок.

### Поведение extract_text_selection

`extract_text_selection` создаёт новую article-карточку из выделенного текста в
открытой статье. Новая карточка хранит snapshot выделения; постоянной
синхронизации с исходным параграфом нет.

1. Проверить vault state, `source_slug`, optional `target_tag`, non-empty
   `selected_text`, body hash and selected source block range.
2. Перечитать source `.md` с диска; если `source_body_hash` устарел, вернуть
   typed stale-selection error без записи.
3. Найти первый Markdown block выбранного диапазона.
4. Если у блока уже есть Obsidian block id, использовать его; иначе вставить
   readable `^block-id` в конец этого блока, сохранив остальные байты файла.
5. Если patch source unsafe (code fence, table, raw HTML, ambiguous range),
   вернуть recoverable error без создания новой карточки.
6. Создать новый `article` block с body snapshot, `Mine Collections` целевой
   коллекции и `Mine Related Notes: [[Source#^block-id]]`. Empty `target_tag`
   means Everything and writes no collection membership.
7. Persist/index через reference-block path: media copy не выполняется.
8. Re-index source block после patch, чтобы body hash и wikilinks были свежими.
9. Эмитить `block:added` и `thumb:updated` для нового блока; source Detail
   остаётся открытым.

### Поведение delete_text_selection

`delete_text_selection` удаляет выделенный текст из source article без создания
нового блока.

1. Проверить vault state, `source_slug`, non-empty `selected_text`, body hash
   and selected source block range.
2. Перечитать source `.md` с диска; если `source_body_hash` устарел, вернуть
   typed stale-selection error без записи.
3. Найти selected text exact match; если rendered selection collapsed whitespace,
   использовать whitespace-normalized search с сохранением source byte span.
4. Проверить, что начало найденного span принадлежит первому selected Markdown
   block range. Это защищает повторяющиеся фрагменты от удаления не из того
   параграфа.
5. Patch source body range in place, сохранить остальные байты файла, re-index
   source block и вернуть обновлённый `IndexedBlock`.
6. Если patch/reindex unsafe или падает, восстановить original source content и
   вернуть typed error.
7. Эмитить `thumb:updated` для source block; `block:added` не эмитится.

### Поведение merge_blocks

`merge_blocks(ordered_slugs)` объединяет две и более выбранные карточки в одну
новую article-карточку. Детальный продуктовый и файловый контракт описан в
[SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md).

Интеграционный инвариант: frontend не собирает Merge из `createBlock` и N
`deleteBlock` вызовов. Это один command, потому что операция одновременно
создаёт новый Markdown, удаляет source `.md`, переписывает внешние ссылки и
обновляет индекс.

1. Проверить vault state, количество slugs, уникальность slugs, существование
   и parseability каждого source block.
2. Отклонить `channel`/collection source blocks.
3. Построить pure merge plan: frontmatter output, body sections, output slug,
   deleted source files, external many-to-one wikilink rewrites.
4. Записать новый `.md` create-new semantics.
5. Применить external rewrites для parseable non-selected `.md` files that
   reference selected source slugs.
6. Только после успешной записи и rewrites удалить selected source `.md` files.
7. Не копировать, не переименовывать и не удалять media binaries.
8. Проиндексировать новый блок и rewritten files, удалить index rows source
   blocks, обновить thumbnail/preview для нового блока.
9. Если apply падает после первой записи, выполнить best-effort rollback:
   удалить merged `.md`, восстановить исходные bytes rewritten files/source
   files и восстановить index rows из восстановленного Markdown.
10. Эмитить `block:added` для merged block, `block:removed` для source slugs,
   `thumb:updated` для merged slug и `vault-changed` для route/index refresh.
11. Вернуть `MergeBlocksResult` с новым `IndexedBlock`, `merged_slug` and
    `removed_slugs`.

In-app rename must preserve block-reference anchors when rewriting source
targets:

```diff
- [[Old Source#^attention-is-selection]]
+ [[New Source#^attention-is-selection]]
```

### Поведение delete_block

1. `prepare_delete_block` строит `DeleteBlockPlan`: `.md`, media текущего блока, media, используемые другими блоками, и unused media.
2. Media refs резолвятся через общий backend resolver (`frontmatter.file`, `thumbnail`, `![[...]]`, `![](...)`, nested/relative/Obsidian basename lookup).
3. `delete_block(..., delete_unused_media=true)` удаляет `.md` и все unused media из плана; shared media не удаляются.
4. `delete_block(..., delete_unused_media=false)` удаляет только `.md` и derived artifacts.
5. Legacy-вызов без `delete_unused_media` сохраняет старый режим: удаляет `.md` и только slug-owned primary media.
6. Индекс удаляется только после успешного file cleanup; если удаление файлов упало, карточка не получает ложный successful delete.

### Поведение batch delete

1. `prepare_delete_blocks(slugs)` строит один aggregate `DeleteBlocksPlan` для
   всего выбранного множества.
2. План резолвит media refs тем же backend resolver, что single delete:
   `frontmatter.file`, `thumbnail`, Obsidian wikilinks, legacy Markdown image
   URLs, nested/relative/basename lookup.
3. `unused_media` считается после мысленного удаления всех `slugs`: media,
   referenced only by selected cards, попадает в план один раз даже если его
   используют несколько выбранных карточек.
4. `shared_media` — media, у которого остаётся хотя бы одна parseable reference
   из невыбранной карточки/заметки; batch command никогда не удаляет такие
   файлы.
5. `delete_blocks(..., delete_unused_media=false)` удаляет `.md` выбранных
   карточек и derived artifacts, но оставляет все media files.
6. `delete_blocks(..., delete_unused_media=true)` удаляет `.md` выбранных
   карточек и только eligible `unused_media` из свежего batch plan; shared media
   остаётся на диске.
7. Commit command должен пересобрать или валидировать план внутри backend перед
   file mutation, чтобы stale frontend plan не удалил media, которая стала
   shared после открытия dialog.
8. Frontend не должен выполнять batch delete как N вызовов `delete_block`.
   Один backend command нужен для единого плана, дедупликации media, одного
   refresh path и понятного failure surface.

### Поведение rename_block_file

1. NFC-normalize `new_stem`, удалить опциональное `.md`, провалидировать как safe filename stem
2. Если target имя уже занято — вернуть typed error `NameTaken`
3. Спланировать source-vault rewrite:
   - переименовать `.md` файл блока
   - переименовать Mine-owned rename-family (`old_slug.ext`, `old_slug (image N).*`, `old_slug (video N).*`)
   - переписать wikilinks и file references по parseable `.md` в vault
4. Временно suppress'ить затрагиваемые paths в `AppState`
5. Записать переписанные `.md`, выполнить file renames, перенести derived artifacts
6. Обновить индекс и эмитить `block:renamed { old_slug, new_slug }`

Boundary:
- `new_stem` is a filename change, not a title edit; in-app rename must not
  synthesize or rewrite `frontmatter.title`, and it must not edit body H1
- если rename меняет speakable article text через отдельный body/H1 edit,
  article-audio invalidируется вместо silent stale migration
- custom media filenames, не совпадающие с Mine naming patterns, не переименовываются
- external rename и in-app rename разделены: rewrite других `.md` происходит только в explicit command path

---

## commands/tags

```rust
#[tauri::command] list_tags(state) -> Result<Vec<TagCount>, CommandError>
#[tauri::command] add_tag(state, slug: String, tag: String) -> Result<(), CommandError>
#[tauri::command] remove_tag(state, slug: String, tag: String) -> Result<(), CommandError>
```

### Поведение add_tag / remove_tag

1. Прочитать `.md` файл → распарсить блок
2. Добавить/удалить тег из `frontmatter.tags`
3. Записать файл обратно
4. Переиндексировать блок

---

## commands/search

```rust
#[tauri::command] search(state, query: String) -> Result<Vec<IndexedBlock>, CommandError>
```

Делегирует в `domain::search::parse_search_query` → `storage::index::search_blocks`.
Это legacy/backend utility command. Новый пользовательский Surface Search не
должен восстанавливать отдельный Search frontend или `Cmd+K` command palette:
Main/Grid search идёт через `list_grid_blocks(..., query)` и возвращает
`GridSnapshot`, чтобы текущий Grid route фильтровался in place. Hybrid Search
остаётся за тем же command boundary: lexical/alias/fuzzy/semantic retrieval и
fusion/rerank реализуются внутри backend SearchEngine, без нового frontend route
или отдельной command palette.

---

## commands/channels

```rust
#[tauri::command] list_channels(state) -> Result<Vec<ChannelDto>, CommandError>
#[tauri::command] create_channel(state, tag: String) -> Result<ChannelDto, CommandError>
#[tauri::command] delete_channel(state, tag: String) -> Result<bool, CommandError>
```

`ChannelDto` — сериализуемая версия `Channel` для фронтенда. В DTO нет
отдельного `title`: отображаемое имя коллекции выводится из Markdown
collection ref / имени файла.
