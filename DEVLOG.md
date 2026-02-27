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

## 27.02.2026 — Drag-and-drop, file watcher, импорт из Are.na

### Goal
Добавить три ключевых интерактивных механики: drag-and-drop файлов для быстрого создания блоков, автообновление интерфейса при внешних изменениях vault, встроенный импорт коллекций из Are.na.

### Planned
1. DropZone — компонент перетаскивания файлов (Tauri v2 onDragDropEvent)
2. File watcher — notify-крейт, фоновый поток, события vault-changed
3. Are.na импорт — HTTP-клиент (ureq), маппинг типов, загрузка медиа, UI

### Actually completed
Все 3 пункта выполнены. 197 тестов проходят.

**Drag-and-drop (5.10):**
- `src/components/DropZone.tsx` — оверлей при перетаскивании, определение типа блока по расширению, создание через create_block

**File watcher (5.12):**
- `src-tauri/src/watcher/watch.rs` — notify-вотчер в фоновом потоке, собственное SQLite-соединение (WAL), debounce 300мс
- `src-tauri/src/commands/state.rs` — RecommendedWatcher в AppState
- `src-tauri/src/commands/vault.rs` — запуск вотчера в initialize_vault
- `src/App.tsx` — подписка на vault-changed с debounce 500мс

**Импорт из Are.na (Phase 6):**
- `src-tauri/src/import/arena_api.rs` — HTTP-клиент: пагинация, rate-limiting, загрузка файлов
- `src-tauri/src/import/importer.rs` — маппинг Are.na → local blocks, прогресс-коллбэк
- `src-tauri/src/commands/import.rs` — list_arena_channels, import_arena_channels
- `src/components/ImportDialog.tsx` — 4-шаговый UI: username → выбор каналов → прогресс → результаты
- `src/components/Sidebar.tsx` — кнопка "Import from Are.na"

### Deviations from plan
- Phase 6 реализована без отдельной SPEC — переиспользована архитектура существующих модулей
- Авторизация Are.na не нужна — публичные каналы доступны без токена
- 5.11 (sidebar drag-reorder) отложен — не критичен для функциональности

### Checks
- `cargo check` — Rust компилируется (15 предупреждений, 0 ошибок)
- `tsc --noEmit` — TypeScript компилируется чисто
- `cargo test` — 197/197 пройдено
- 15 Tauri-команд зарегистрированы

### Push
- `2f147ba` — Add drag-and-drop file import and real-time vault watcher
- (ожидает коммит) — Are.na import

### Decisions and lessons learned
1. **ureq вместо reqwest**: синхронный HTTP-клиент, Tauri-команды всё равно на thread pool. Нет async-рантайма, нет лишней сложности
2. **Отдельное SQLite-соединение для watcher**: WAL-режим позволяет несколько reader-ов. Watcher в фоновом потоке не блокирует UI-команды
3. **Прогресс через Tauri events**: `app.emit("import-progress", ...)` — фронтенд подписывается через `listen()`, обновляет progress bar без polling
4. **Переиспользование storage-слоя в импорте**: `files::write_block_file`, `index::upsert_block`, `thumbnails::generate_thumbnail` — одна и та же логика для ручного создания и импорта

---

## 27.02.2026 — Frontend: компоненты, роутинг, IPC

### Goal
Пользователь видит интерфейс приложения: выбирает vault, видит сетку карточек, переключает каналы в sidebar, ищет по Cmd+K, открывает детальный вид.

### Planned
1. SPEC_FRONTEND.md — спецификация: типы, IPC, компоненты, роутинг, ассеты
2. Установка зависимостей: @tauri-apps/api, @tauri-apps/plugin-dialog, @tanstack/react-virtual, react-router
3. TypeScript types + IPC layer (13 typed commands)
4. VaultPicker — экран выбора vault
5. Sidebar — навигация по каналам
6. Grid — виртуальный скроллинг
7. Card — адаптивные карточки (5 типов блоков)
8. Search — Cmd+K палитра поиска
9. Detail — lightbox с управлением тегами
10. App — роутинг, состояние, компоновка

### Actually completed
Все 10 пунктов выполнены. Фронтенд собирается (263 КБ JS / 83 КБ gzip).

- `SPEC_FRONTEND.md` — спецификация фронтенда
- `src/types/index.ts` — IndexedBlock, TagCount, ChannelDto, ScanResult, CreateBlockParams
- `src/lib/commands.ts` — 13 типизированных обёрток над invoke()
- `src/lib/assets.ts` — thumbnailUrl, mediaUrl, domainFromUrl (convertFileSrc)
- `src/components/VaultPicker.tsx` — нативный dialog для выбора папки, сканирование vault
- `src/components/Sidebar.tsx` — каналы с счётчиками, NavLink-навигация, кнопка Cmd+K
- `src/components/Grid.tsx` — @tanstack/react-virtual, адаптивные столбцы (ResizeObserver), overscan=5
- `src/components/Card.tsx` — ImageCard, LinkCard, ArticleCard, VideoCard, FileCard
- `src/components/Search.tsx` — модальное окно, debounce 200мс, навигация стрелками, Enter/Esc
- `src/components/Detail.tsx` — lightbox по типу блока, добавление/удаление тегов, стрелки лево-право
- `src/App.tsx` — BrowserRouter, Outlet context, AllBlocksPage, ChannelPage, глобальный Cmd+K
- `src/styles/global.css` — скрытие скроллбаров WebKit, user-select для кнопок, overscroll-behavior
- `src-tauri/Cargo.toml` — feature `protocol-asset` для отображения файлов
- `src-tauri/tauri.conf.json` — assetProtocol: enable + scope **
- `src-tauri/capabilities/default.json` — dialog:default, dialog:allow-open
- `src-tauri/src/lib.rs` — регистрация tauri_plugin_dialog
- `package.json` — @tauri-apps/api, @tauri-apps/plugin-dialog, @tanstack/react-virtual, react-router

### Deviations from plan
- Drag-and-drop файлов отложен — требует tauri-plugin-fs и дополнительную логику копирования
- Sidebar drag-reorder каналов отложен — требует обновление позиции в бэкенде
- Real-time updates (Tauri events → React state) отложены — требует подписку на события watcher
- Masonry/list режимы сетки отложены — базовый grid покрывает основные сценарии
- Тесты компонентов отложены — тестирование через Tauri runtime требует дополнительной инфраструктуры

### Checks
- `tsc --noEmit` — компиляция TypeScript без ошибок
- `bun run build` — сборка Vite успешна (263 КБ JS)
- `cargo check` — Rust компилируется (с protocol-asset feature)
- `cargo test --lib` — 193/193 тестов пройдены
- Все 13 IPC-команд строго типизированы
- Dark mode: все компоненты используют dark: варианты Tailwind

### Push
- `d60ced6` — Implement frontend: VaultPicker, Sidebar, Grid, Card, Search, Detail

### Decisions and lessons learned
1. **convertFileSrc + protocol-asset**: Tauri WebView не загружает file:// URL. Необходим feature `protocol-asset` в Cargo.toml + `assetProtocol.enable` в tauri.conf.json. convertFileSrc преобразует путь в asset://localhost/...
2. **Outlet context вместо prop drilling**: react-router `<Outlet context={...}>` + `useOutletContext<T>()` — чистый способ передать blocks/vaultPath во вложенные маршруты без пробрасывания через 5 уровней
3. **ResizeObserver для адаптивных столбцов**: Grid вычисляет количество столбцов через ResizeObserver на контейнере, а не через window.innerWidth. Это правильно работает при изменении ширины sidebar
4. **Debounce 200мс для поиска**: баланс между отзывчивостью и нагрузкой на SQLite. FTS5 быстр (<10мс), но debounce предотвращает лишние вызовы при быстром вводе
5. **Spread operator для CreateBlockParams**: TypeScript interface несовместим с Record<string, unknown> (нет index signature). Решение: `{ ...params }` создаёт plain object

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
