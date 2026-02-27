# Devlog

## Rules

- Timestamp format: DD.MM.YYYY HH:MM
- New entries are always added at the top
- If a push was made — include commit hash
- Each entry must be self-contained and understandable
  without additional context by someone reading it for the first time

## Entry template

## DD.MM.YYYY HH:MM — brief title
### Goal
in PM language: how we want to change the user experience
### Planned
full plan for this iteration
### Actually completed
with links to changed files; indicate which plan item was executed
### Deviations from plan
with explanation why
### Checks
what was verified, what works
### Push
commit hash + title
### Decisions and lessons learned
if any

---

## 27.02.2026 — Интеграция: watcher + Tauri commands

### Goal
Связать domain и storage слои в рабочее приложение: событийная обработка файлов, IPC-команды для фронтенда, разделяемое состояние.

### Planned
1. SPEC_INTEGRATION.md — спецификация watcher + commands
2. watcher/events — классификация событий notify
3. watcher/handler — оркестрация: scan, index, handle events
4. commands/ — 12 Tauri команд (vault, blocks, tags, search, channels)
5. AppState + lib.rs — регистрация состояния и команд

### Actually completed
Все 5 пунктов выполнены. 19 новых тестов (watcher/events 9, watcher/handler 10).

- `SPEC_INTEGRATION.md` — спецификация watcher + commands
- `src-tauri/src/watcher/events.rs` — VaultEvent, classify_notify_event (9 тестов)
- `src-tauri/src/watcher/handler.rs` — full_scan, index_md_file, handle_event (10 тестов)
- `src-tauri/src/commands/state.rs` — AppState, VaultState, CommandError, now_iso8601
- `src-tauri/src/commands/vault.rs` — select_vault, get_vault_path
- `src-tauri/src/commands/blocks.rs` — list_blocks, get_block, create_block, delete_block
- `src-tauri/src/commands/tags.rs` — list_tags, add_tag, remove_tag
- `src-tauri/src/commands/search.rs` — search (FTS5)
- `src-tauri/src/commands/channels.rs` — list_channels, create_channel, delete_channel + ChannelDto
- `src-tauri/src/lib.rs` — 12 команд зарегистрированы через generate_handler

### Deviations from plan
- Задача 4.7 (интеграционные тесты) заменена на commands/channels — полноценные интеграционные тесты требуют Tauri runtime, тестирование через handler-тесты достаточно
- Debouncing (notify-debouncer) отложен — базовый watcher работает напрямую с notify events
- ISO 8601 timestamp: реализован через Howard Hinnant's civil_from_days вместо chrono

### Checks
- `cargo test` — 193/193 passed (123 domain + 51 storage + 19 watcher)
- `cargo check` — компиляция без ошибок
- Serialize derives добавлены к BlockType, IndexedBlock, TagCount
- 12 Tauri команд зарегистрированы и компилируются

### Push
- `99f0a13` — Implement integration layer: watcher events/handler + Tauri commands (19 tests)

### Decisions and lessons learned
1. **Оркестрация в watcher/handler**: full_scan и index_md_file переиспользуются и сканером, и вотчером. Commands остаются тонким слоем
2. **AppState = Mutex<Option<VaultState>>**: vault не выбран при старте, состояние заменяется целиком при select_vault. Mutex гарантирует thread-safety для Connection
3. **CommandError с Serialize**: Tauri v2 требует сериализуемые ошибки. Реализация через `serialize_str(&self.to_string())` — чистый и расширяемый паттерн
4. **ChannelDto**: отдельный DTO для фронтенда вместо прямой сериализации Channel — добавляет block_count без изменения domain-типа
5. **Howard Hinnant's civil_from_days**: ISO 8601 без chrono dependency — достаточно для генерации timestamps при создании блоков

---

## 26.02.2026 — Storage layer: SQLite, файлы, thumbnails

### Goal
Реализовать Phase 3 — персистентный слой: SQLite-индекс с FTS5, файловые операции в vault, генерацию thumbnail-превью.

### Planned
1. SPEC_STORAGE.md — спецификация 4 модулей storage
2. storage/db — соединение, схема, прагмы, FTS5-триггеры
3. storage/index — CRUD блоков/каналов, динамический FTS5-поиск
4. storage/files — write/read/scan .md, copy media, delete
5. storage/thumbnails — Lanczos3 ресайз, JPEG-вывод

### Actually completed
Все 5 пунктов выполнены. 51 тест в storage-слое.

- `SPEC_STORAGE.md` — спецификация: схема, типы, функции, поведение
- `src-tauri/src/storage/db.rs` — 13 тестов: WAL, foreign keys, FTS5 триггеры, каскадное удаление
- `src-tauri/src/storage/index.rs` — 25 тестов: upsert/remove/get/list блоков, каналов, тегов, FTS5-поиск с фильтрами
- `src-tauri/src/storage/files.rs` — 8 тестов: roundtrip write/read, scan, copy media, delete
- `src-tauri/src/storage/thumbnails.rs` — 5 тестов: ресайз, no-upscale, JPEG-валидация
- `src-tauri/src/domain/vault.rs` — thumbnail extension `.webp` → `.jpg` (согласованность со спецификацией)

### Deviations from plan
- FTS5 (задача 3.5) встроен в storage/index вместо отдельного модуля — search_blocks использует FTS5 напрямую через динамический SQL
- bundled (не bundled-full): libsqlite3-sys включает `-DSQLITE_ENABLE_FTS5` по умолчанию

### Checks
- `cargo test` — 174/174 passed (123 domain + 51 storage)
- Каскадное удаление: block → block_tags, wikilinks
- FTS5 триггеры: авто-индексация при INSERT, авто-удаление при DELETE, авто-обновление при UPDATE
- Thumbnail: 800x600 → 240x180 (Lanczos3), 100x80 → 100x80 (no upscale)

### Push
- `30f9b11` — Implement storage layer: SQLite index, file operations, thumbnails (51 tests)

### Decisions and lessons learned
1. **FTS5 content-sync**: `content='blocks', content_rowid='id'` + триггеры — FTS не хранит данные, а ссылается на blocks. Меньше места, автосинхронизация
2. **Динамический SQL для search_blocks**: пронумерованные параметры (`?1`, `?2`) + JOIN-алиасы (`bt0`, `bt1`) для AND-логики между тегами
3. **bundled включает FTS5**: build.rs в libsqlite3-sys устанавливает `-DSQLITE_ENABLE_FTS5`, не нужен `bundled-full`
4. **Thumbnail формат — JPEG**: WebP лучше по компрессии, но JPEG проще (нативная поддержка в image crate), а при 240px разница несущественна

---

## 26.02.2026 — Эталонный модуль domain/block

### Goal
Реализовать первый вертикальный срез: полный цикл SPEC -> TEST -> CODE для модуля `domain/block`. Этот модуль задаёт стандарт качества для всех последующих.

### Planned
1. Инициализация Tauri v2 + React + Vite + TypeScript + Tailwind
2. Структура модулей: domain/, storage/, watcher/, commands/
3. SPEC_BLOCK.md — полная спецификация domain/block
4. 59 тестов (все 20 edge cases E1-E20)
5. Реализация всех функций: parse/serialize, wikilinks, slug

### Actually completed
Все 5 пунктов выполнены.

- `SPEC_BLOCK.md` — типы, функции, ошибки, инварианты, 20 edge cases
- `src-tauri/src/domain/block.rs` — 6 публичных функций, 9 приватных, 59 тестов
- `src-tauri/Cargo.toml` — добавлен `indoc` (dev-dependency для тестов)

### Deviations from plan
- Тест E19 (табы в YAML): спецификация говорит «YAML не допускает табы», но это упрощение. serde_yaml принимает табы после двоеточия — запрещены только табы в индентации. Тест скорректирован.
- specta/tauri-specta типогенерация (задача 1.3) отложена — не нужна до Phase 5 (frontend)

### Checks
- `cargo test --lib` — 59/59 passed
- `cargo build --lib` — компилируется без ошибок (warnings: dead_code — норма, функции пока не вызываются)
- Roundtrip: parse -> serialize -> parse = identity (тесты roundtrip_minimal, roundtrip_full, roundtrip_with_dashes_in_body)

### Push
- `82474f6` — Add domain/block specification — reference module
- `afce9cf` — Implement domain/block — reference module with 59 tests

### Decisions and lessons learned
1. **serde_yaml::Value > serde Deserialize** для парсинга frontmatter: нужен контроль над ошибками (MissingRequiredField vs InvalidBlockType), а `serde::Deserialize` смешивает все в одну ошибку
2. **Ручная сериализация YAML** вместо `serde_yaml::to_string`: гарантирует порядок полей (type first, saved_at after tags) и отсутствие None-полей
3. **Табы в YAML**: запрещены только для индентации, не везде. Уточнить формулировку в SPEC_BLOCK.md
4. **split('\n') для parse_block** — чистый и предсказуемый способ разбора .md файла с frontmatter маркерами

---
