# SPEC: integration layer (watcher + commands)

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

Связующий слой: file watcher отслеживает изменения в vault, Tauri commands предоставляют API для фронтенда. Оркестрация файл → парсинг → индексация → thumbnail.

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
- Игнорирует пути внутри `.arena/`
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

- Вызывает `storage::files::scan_md_files` для получения всех `.md`
- Для каждого файла: `read_block_file` → `parse_block` → `upsert_block` + collect `ThumbJob`
- Thumbnails генерируются в фоновом потоке через `storage::thumbnails::generate_for_block` (unified cascade)
- Ошибки парсинга отдельных файлов логируются, не прерывают сканирование
- Возвращает `ScanResult { indexed, errors }`
- После completion background thumb gen вызывает `on_thumbs_done` callback (notify frontend to refresh previews)

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

### Tauri events (frontend subscribers)

Все события эмитятся через `tauri::Manager::emit`. Frontend subscribers в `src/hooks/useChannelPreviewsEvents.ts` и `src/hooks/useThumbnailUpgrade.ts`.

| Event | Payload | Emitted by |
|---|---|---|
| `block:added` | `{ slug: string, tags: string[], is_text: boolean }` | `index_md_file` после `upsert_block` |
| `block:removed` | `{ slug: string, tags: string[] }` | `handle_event::BlockDeleted` |
| `block:renamed` | `{ old_slug: string, new_slug: string }` | watcher external rename path и `rename_block_file` |
| `thumb:updated` | `{ slug: string }` | `save_thumb` command и фоновая генерация |
| `thumb:upgrade-requested` | `{ slug: string, media_path: string, kind: "image" \| "video" }` | `index_md_file` когда Rust cascade дал text placeholder для block с embedded media |

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
#[tauri::command] select_vault(state, path: String) -> Result<ScanResult, CommandError>
#[tauri::command] get_vault_path(state) -> Result<Option<String>, CommandError>
```

### Поведение select_vault

1. Создать `VaultLayout` из `path`
2. Создать `.arena/cache/thumbs/` директории
3. Открыть/создать БД (`storage::db::open_or_create`)
4. Полное сканирование (`watcher::handler::full_scan`)
5. Обновить `AppState.vault_state`
6. Вернуть `ScanResult`

---

## commands/blocks

```rust
#[tauri::command] list_blocks(state) -> Result<Vec<IndexedBlock>, CommandError>
#[tauri::command] get_block(state, slug: String) -> Result<Option<IndexedBlock>, CommandError>
#[tauri::command] create_block(state, ...) -> Result<IndexedBlock, CommandError>
#[tauri::command] extract_text_selection(state, ...) -> Result<IndexedBlock, TextSelectionExtractError>
#[tauri::command] prepare_delete_block(state, slug: String) -> Result<DeleteBlockPlan, CommandError>
#[tauri::command] delete_block(state, slug: String, delete_unused_media: Option<bool>) -> Result<bool, CommandError>
#[tauri::command] rename_block_file(state, old_slug: String, new_stem: String) -> Result<RenameBlockResult, RenameBlockError>
```

### Поведение create_block

1. Сгенерировать slug из first body H1 / readable seed / url, without
   synthesizing `frontmatter.title`
2. Разрешить конфликт slug (через `resolve_slug_conflict`)
3. Создать `Block` с frontmatter
4. Записать `.md` файл
5. Скопировать медиафайл (если есть)
6. Сгенерировать thumbnail (если изображение)
7. Проиндексировать
8. Вернуть `IndexedBlock`

### Поведение extract_text_selection

`extract_text_selection` создаёт новую article-карточку из выделенного текста в
открытой статье. Новая карточка хранит snapshot выделения; постоянной
синхронизации с исходным параграфом нет.

1. Проверить vault state, `source_slug`, `target_tag`, non-empty
   `selected_text`, body hash and selected source block range.
2. Перечитать source `.md` с диска; если `source_body_hash` устарел, вернуть
   typed stale-selection error без записи.
3. Найти первый Markdown block выбранного диапазона.
4. Если у блока уже есть Obsidian block id, использовать его; иначе вставить
   readable `^block-id` в конец этого блока, сохранив остальные байты файла.
5. Если patch source unsafe (code fence, table, raw HTML, ambiguous range),
   вернуть recoverable error без создания новой карточки.
6. Создать новый `article` block с body snapshot, `Mine Collections` целевой
   коллекции и `Mine Related Notes: [[Source#^block-id]]`.
7. Persist/index через reference-block path: media copy не выполняется.
8. Re-index source block после patch, чтобы body hash и wikilinks были свежими.
9. Эмитить `block:added` и `thumb:updated` для нового блока; source Detail
   остаётся открытым.

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

---

## commands/channels

```rust
#[tauri::command] list_channels(state) -> Result<Vec<ChannelDto>, CommandError>
#[tauri::command] create_channel(state, tag: String, title: Option<String>) -> Result<ChannelDto, CommandError>
#[tauri::command] delete_channel(state, tag: String) -> Result<bool, CommandError>
```

`ChannelDto` — сериализуемая версия `Channel` для фронтенда.
