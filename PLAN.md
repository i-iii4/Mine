# Implementation Plan

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md)

## Goal

Создать технически совершенное десктопное приложение для macOS — локальную альтернативу Are.na. Файлы на диске (Markdown + frontmatter), каналы — теги, плавный интерфейс на 10 000+ блоков.

**Это не MVP.** Каждый модуль реализуется в финальном качестве.

## Стратегия: вертикальные срезы с эталонным модулем

Каждый модуль проходит полный цикл:
```
SPEC → TEST (красные) → CODE (зелёные) → VERIFY → COMMIT
```

Фаза 1 создаёт **эталонный модуль** (`domain/block`) — образец качества для всех остальных. Уроки из каждого модуля влияют на спецификацию следующего.

## Phases

### Phase 0 — Архитектура и документация [COMPLETED]

Goal: полный каркас проекта — принципы, архитектура, PRD, юзкейсы.

| # | Task | Status |
|---|------|--------|
| 0.1 | CLAUDE.md, ARCHITECTURE.md, PLAN.md, DEVLOG.md | [x] |
| 0.2 | PRINCIPLES.md — инженерные принципы и антипаттерны | [x] |
| 0.3 | SPEC_PRD.md — модель данных, типы блоков, интерфейс | [x] |
| 0.4 | SPEC_USECASES.md — юзкейсы и сценарии | [x] |
| 0.5 | Git + GitHub репозиторий | [x] |

### Phase 1 — Эталонный модуль + инициализация [COMPLETED]

Goal: Tauri-проект инициализирован, `domain/block` реализован идеально — спецификация, тесты, код. Это образец для всех модулей.

| # | Task | Status |
|---|------|--------|
| 1.1 | Инициализация Tauri v2 + React + Vite + TypeScript + Tailwind | [x] |
| 1.2 | Структура директорий: domain/, storage/, watcher/, commands/ | [x] |
| 1.3 | Настройка specta для типогенерации Rust → TypeScript | отложено до Phase 5 |
| 1.4 | SPEC_BLOCK.md — спецификация domain/block | [x] |
| 1.5 | Тесты domain/block (59 тестов, все 20 edge cases) | [x] |
| 1.6 | Реализация domain/block (59/59 зелёных) | [x] |
| 1.7 | Ретроспектива | [x] |

### Phase 2 — Domain layer [COMPLETED]

Goal: вся бизнес-логика реализована и протестирована. Чистые типы и функции, без зависимостей от Tauri/SQLite.

| # | Task | Status |
|---|------|--------|
| 2.1 | SPEC + TEST + CODE: domain/tag (12 тестов) | [x] |
| 2.2 | SPEC + TEST + CODE: domain/channel (20 тестов) | [x] |
| 2.3 | SPEC + TEST + CODE: domain/vault (13 тестов) | [x] |
| 2.4 | SPEC + TEST + CODE: domain/search (15 тестов) | [x] |

### Phase 3 — Storage layer [COMPLETED]

Goal: SQLite-индекс, файловые операции, thumbnail-пайплайн. Всё персистентное.

| # | Task | Status |
|---|------|--------|
| 3.1 | SPEC + TEST + CODE: storage/db (схема, FTS5 триггеры, WAL) | [x] |
| 3.2 | SPEC + TEST + CODE: storage/index (CRUD блоков/каналов/тегов, поиск) | [x] |
| 3.3 | SPEC + TEST + CODE: storage/files (write, read, scan, copy, delete) | [x] |
| 3.4 | SPEC + TEST + CODE: storage/thumbnails (Lanczos3 ресайз, JPEG) | [x] |
| 3.5 | SPEC + TEST + CODE: FTS5 поиск (встроен в storage/index) | [x] |

### Phase 4 — Watcher + Commands (интеграция) [COMPLETED]

Goal: file watcher отслеживает vault, Tauri commands связывают бэкенд с фронтендом. Полный сканер vault.

| # | Task | Status |
|---|------|--------|
| 4.1 | SPEC + TEST + CODE: watcher/events (классификация notify событий, 9 тестов) | [x] |
| 4.2 | SPEC + TEST + CODE: watcher/handler (full_scan, index_md_file, handle_event, 10 тестов) | [x] |
| 4.3 | SPEC + TEST + CODE: commands/vault (select_vault, get_vault_path) | [x] |
| 4.4 | SPEC + TEST + CODE: commands/blocks (list, get, create, delete) | [x] |
| 4.5 | SPEC + TEST + CODE: commands/tags (list, add, remove) | [x] |
| 4.6 | SPEC + TEST + CODE: commands/search (FTS5 query) | [x] |
| 4.7 | commands/channels (list, create, delete) + AppState + lib.rs wiring | [x] |

### Phase 5 — Frontend [COMPLETED]

Goal: полноценный UI — сетка, sidebar, детальный вид, поиск. 60 fps на 10 000 блоков.

| # | Task | Status |
|---|------|--------|
| 5.1 | SPEC_FRONTEND.md: компоненты, типы, IPC, роутинг | [x] |
| 5.2 | TypeScript types + IPC layer (18 команд) | [x] |
| 5.3 | VaultPicker: выбор папки через системный диалог | [x] |
| 5.4 | Sidebar: каналы, счётчики, навигация, кнопка импорта | [x] |
| 5.5 | Grid: чанковый рендеринг (IntersectionObserver, 80+60 батчи) | [x] |
| 5.6 | Card: адаптивные карточки по типу блока (5 типов) + фолбэк для сломанных изображений | [x] |
| 5.7 | Search: Cmd+K, command palette, debounced FTS5 | [x] |
| 5.8 | Detail: lightbox, теги (добавить/удалить), навигация стрелками | [x] |
| 5.9 | App: роутинг (react-router), состояние vault, загрузка данных | [x] |
| 5.10 | Drag-and-drop файлов → создание блока (DropZone) | [x] |
| 5.11 | Sidebar drag-reorder каналов (HTML5 DnD, reorder_channels команда) | [x] |
| 5.12 | Real-time updates: Tauri events → React state (vault-changed) | [x] |
| 5.13 | Тёмная/светлая тема (системная) — базовая поддержка через dark: | [x] |
| 5.14 | Тесты компонентов (vitest + testing-library, 43 теста, 5 файлов) | [x] |

### Phase 6 — Импорт из Are.na [COMPLETED]

Goal: пользователь переносит каналы из Are.na.

| # | Task | Status |
|---|------|--------|
| 6.1 | Are.na API клиент: пагинация, rate-limiting, десериализация (ureq) | [x] |
| 6.2 | Маппинг: Are.na block → .md + медиафайл, channel → тег | [x] |
| 6.3 | Загрузка медиафайлов и генерация thumbnails | [x] |
| 6.4 | Tauri-команды: list_arena_channels, import_arena_channels | [x] |
| 6.5 | UI импорта: ImportDialog (ввод username, выбор каналов, прогресс-бар) | [x] |
| 6.6 | Тестирование с реальными данными | отложено |

### Phase 7 — Финализация [IN PROGRESS]

Goal: продакшен-готовность. Профилирование, edge cases, сборка.

| # | Task | Status |
|---|------|--------|
| 7.1 | Чанковый рендеринг Grid (IntersectionObserver, 80+60 батчи) | [x] |
| 7.2 | Edge cases: фолбэк при сломанных изображениях, missing media | [x] |
| 7.3 | Пересборка индекса из файлов (rebuild_index команда) | [x] |
| 7.4 | Автообновление (Tauri updater) | отложено — требует ручной генерации ключей |
| 7.5 | Иконка (SVG → icns/ico/png), нативное macOS-меню, About | [x] |
| 7.6 | Сборка .dmg, подпись, нотаризация | [ ] |
| 7.7 | Исправление drag-and-drop: rename_all = "snake_case" для create_block (Tauri v2 camelCase по умолчанию) | [x] |
| 7.8 | Исправление сброса прокрутки Grid: blocksFingerprint вместо ссылки на массив + отображение ошибок в DropZone | [x] |
| 7.9 | Бэкенд: команда rename_channel (обновление тега во всех .md + индексе) | [x] |
| 7.10 | Теги в сайдбаре: отображение всех уникальных тегов из frontmatter, контекстное меню (переименовать/удалить), inline-редактирование | [x] |
| 7.11 | Drag-and-drop карточки на тег (dnd-kit + PointerSensor): pointerWithin коллизия, autoScroll сайдбара, DragOverlay с snapToCursor | [x] |
| 7.12 | Контекстное меню карточки (правый клик): теги с чекбоксами, поиск, создание нового тега, удаление с подтверждением | [x] |
| 7.13 | Drag-and-drop каналов: @dnd-kit/sortable, SortableContext, reorder_channels с автосозданием записей, кнопка «New channel» | [x] |
| 7.14 | Багфиксы drop-зоны: тег текущего канала при file drop, защита от дублирования, isCardDragging для синего кольца, удаление канала при удалении тега, Unicode в slugifyTag | [x] |
| 7.15 | Качество thumbnail: 240→480px (Retina 2x), JPEG quality 80→85, единая константа DEFAULT_MAX_SIZE | [x] |
| 7.16 | DragOverlay: курсор «держит» карточку за левый верхний угол вместо центра | [x] |
| 7.17 | Меню каналов: скрытие Delete при поиске, создание канала при отсутствии совпадений, MRU-ранжирование (localStorage), единообразие с клиппером | [x] |
| 7.18 | Дизайн-система: shadcn/ui (токены, `cn()`, ThemeProvider, миграция оболочки App+Sidebar на семантические токены) | [x] |
| 7.19 | Миграция всех компонентов на семантические токены: замена neutral-*/dark: на bg-card/text-foreground/border-border/bg-muted и т.д. | [x] |
| 7.20 | shadcn/ui компонентная миграция: 14 примитивов (Button, Input, Badge, Checkbox, Progress, Separator, Dialog, Command, ContextMenu, DropdownMenu, AlertDialog, ScrollArea, Tooltip), glass-токены, lucide-react иконки | [x] |
| 7.21 | Grid: делегирование ContextMenu (O(N)→O(1)) + синхронный сброс visibleCount + исправление скролла контекстного меню + hover сайдбара | [x] |
| 7.22 | Визуальная стилизация: overlay titlebar + drag region, Geist Sans, острые карточки без заливки, GAP 32px, sidebar без заголовка с градиентным fade | [x] |
| 7.23 | Иконки каналов в sidebar: стопка из 1–3 мини-карточек с реальными превью, веерная анимация при ховере | [x] |
| 7.24 | Fullscreen Detail: двухслойный layout (scroll + fixed metadata), Geist Mono, drag region | [x] |
| 7.25 | macOS: NSToolbar → класс окна 26px (Liquid Glass, скругления, отступ светофора) | [x] |

### Phase 8 — Веб-клиппер (браузерное расширение) [COMPLETED]

Goal: расширение для Chrome и Safari — сохранение ссылок, статей, изображений и видео прямо из браузера в vault.

| # | Task | Status |
|---|------|--------|
| 8.1 | SPEC_CLIPPER.md — спецификация: типы клипов, popup UI, native messaging, извлечение метаданных | [x] |
| 8.2 | Native messaging host (Rust-бинарник): чтение vault, запись блоков, индексация, thumbnails | [x] |
| 8.3 | WebExtension: content script (метаданные, Readability.js), popup UI (сегментированный контрол типа, каналы, предпросмотр) | [x] |
| 8.4 | Контекстное меню: Save page / Save image / Save selection / Save link | [x] |
| 8.5 | Автоопределение типа контента (эвристика: article/link/video) + ручное переключение | [x] |
| 8.6 | Safari-обёртка: xcrun safari-web-extension-converter → Xcode-проект | [x] |
| 8.7 | Тестирование с реальными данными (native host дымовой тест пройден) | [x] |
| 8.8 | Ремонт форматирования (tweetTextToMarkdown, убран .textContent) и логики типов (переключатель всегда виден, жадная загрузка статьи, перезапрос выделения) | [x] |
| 8.9 | Переделка UX клиппера: Content/Link, недавние каналы, встроенный список, HTTP-заголовки для загрузки картинок, async контекстное меню | [x] |
| 8.10 | Багфикс: Referer на URL страницы (не картинки), реалистичный User-Agent, windows.create() вместо openPopup(), адаптивный размер окна | [x] |

### Phase 9 — Аудит и укрепление кодовой базы [IN PROGRESS]

Goal: довести проект до продакшен-качества по результатам полного аудита ([AUDIT.md](AUDIT.md)). Устранить все критические и высокие проблемы, закрыть пробелы в тестовом покрытии, укрепить безопасность.

#### 9.1 — Критические исправления (блокеры релиза)

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.1.1 | `panic!()` → `Result` в `resolve_slug_conflict()`: добавить `VaultError::SlugConflictExhausted`, обновить вызывающий код | CRIT-1 | [x] |
| 9.1.2 | Обернуть `upsert_block()` в `conn.unchecked_transaction()` — 6 SQL-операций атомарны | CRIT-2 | [x] |
| 9.1.3 | Исправить N+1: батч-запрос `WHERE block_id IN (...)` + HashMap в `collect_blocks()` | CRIT-3 | [x] |
| 9.1.4 | Включить CSP в `tauri.conf.json`: `default-src 'self'; img-src 'self' asset: https:; style-src 'self' 'unsafe-inline'` | CRIT-4 | [x] |
| 9.1.5 | Исправить XSS в `popup.js`: переписать `renderChannelList()` на DOM API (`textContent` вместо `innerHTML`) | CRIT-5 | [x] |
| 9.1.6 | Установить ESLint 10 + typescript-eslint, создать `eslint.config.js` | CRIT-6 | [x] |

#### 9.2 — Обработка ошибок и безопасность

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.2.1 | Убрать `unwrap_or(BlockType::File)` в `row_to_block()` — `FromSqlConversionFailure` при невалидном типе | HIGH-2 | [x] |
| 9.2.2 | Заменить 20× `lock().unwrap()` на `lock().map_err(CommandError::Internal)` во всех commands | HIGH-3 | [x] |
| 9.2.3 | `unwrap()` на `duration_since(UNIX_EPOCH)` в util.rs → `.expect("system clock is set before Unix epoch")` | HIGH-4 | [x] |
| 9.2.4 | Path traversal: `canonicalize()` + `is_file()` в `create_block` | HIGH-5 | [x] |
| 9.2.5 | `.expect()` → `Result` в `lib.rs:95` — обработать ошибку запуска Tauri | HIGH-10 | [ ] |
| 9.2.6 | Добавить `console.error()` в пустые `catch {}` блоки: Detail.tsx (addTag/removeTag), App.tsx (deleteChannel) | HIGH-7 | [x] |
| 9.2.7 | Open redirect: валидация URL-протокола (`http:`/`https:`) перед рендерингом `<a href>` в Detail.tsx и ArticleBody | MED-8, MED-9 | [ ] |
| 9.2.8 | `unwrap()` в native_host.rs:362, 419 → явная обработка ошибок | — | [ ] |

#### 9.3 — Производительность storage

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.3.1 | Добавить индекс `CREATE INDEX idx_blocks_saved_at ON blocks(saved_at DESC)` | HIGH-1 | [x] |
| 9.3.2 | Добавить индекс `CREATE INDEX idx_block_tags_block_id ON block_tags(block_id)` | HIGH-1 | [x] |
| 9.3.3 | FTS5: указать `tokenize='unicode61 remove_diacritics 0'` для корректного поиска по кириллице | MED-2 | [ ] |
| 9.3.4 | TOCTOU в `delete_block_files()`: ловить `ErrorKind::NotFound` вместо `if exists()` | MED-4 | [ ] |
| 9.3.5 | Лимит на размер изображения перед `image::open()`: проверка `w > 8192 \|\| h > 8192` | MED-5 | [ ] |

#### 9.4 — Фронтенд: устойчивость и консистентность

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.4.1 | Исправить утечку слушателя в ImportDialog: паттерн `isMounted` + guard в `.then()` | HIGH-6 | [ ] |
| 9.4.2 | Заменить хардкод-цвета на семантические токены: `LINK_COLORS` в Card.tsx, `bg-green-*` в ImportDialog, `text-amber-*` в VaultPicker | HIGH-9 | [ ] |
| 9.4.3 | `as PointerEvent` → `instanceof` проверка в App.tsx:37 | MED-12 | [ ] |
| 9.4.4 | Извлечь повторяющийся CSS-класс метаданных (`text-[10px] uppercase tracking-widest`) в `@layer components` | — | [ ] |

#### 9.5 — Веб-клиппер: безопасность и надёжность

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.5.1 | Заменить FIFO-очередь `pendingCallbacks` на `Map<messageId, callback>` в background.js | HIGH-8 | [ ] |
| 9.5.2 | Валидация URL в content.js: `isValidUrl()` проверка перед формированием markdown-ссылок | MED-9 | [ ] |
| 9.5.3 | Ограничить `matches` в manifest.json до `["https://*", "http://*"]` (убрать `<all_urls>`) | — | [ ] |
| 9.5.4 | Таймауты HTTP в native_host.rs: `.timeout(Duration::from_secs(30))` на все `ureq` запросы | MED-6 | [ ] |
| 9.5.5 | Атомарная запись файлов в native_host: write-to-temp → rename | MED-7 | [ ] |
| 9.5.6 | Откатка при ошибке индексации: если `upsert_block()` упал — удалить записанный .md | — | [ ] |

#### 9.6 — Рефакторинг и устранение дублирования

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.6.1 | Вынести `is_image_ext()` в `util.rs` — убрать дублирование между handler.rs и blocks.rs | MED-1 | [ ] |
| 9.6.2 | Разделить ошибки импорта: `ImportError::BlockParseFailed` vs `ImportError::DatabaseFailed` — фатальные останавливают процесс | MED-11 | [ ] |
| 9.6.3 | Восстановление watcher: эмитить `watcher-error` событие, full_scan при накоплении ошибок | MED-10 | [ ] |
| 9.6.4 | Убрать dead code в arena_api.rs: неиспользуемые поля `updated_at`, `base_class`, `file_name` + unused imports | — | [ ] |

#### 9.7 — Тесты: критические пробелы

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.7.1 | Тесты commands/blocks.rs: create_block → write_file → upsert (полный цикл), delete_block, list_blocks, error paths | — | [ ] |
| 9.7.2 | Тесты commands/tags.rs: add_tag, remove_tag, rename_tag, delete_tag_from_all | — | [ ] |
| 9.7.3 | Тесты commands/channels.rs: list, create, delete, reorder, rename | — | [ ] |
| 9.7.4 | Тесты storage/files.rs: delete_block_files (с orphaned media), copy_media_file (конфликты), scan_md_files (пустой vault) | — | [ ] |
| 9.7.5 | Тесты arena_api.rs: мок HTTP (ureq), пагинация, ошибки сети, malformed JSON | — | [ ] |
| 9.7.6 | Тесты watcher/watch.rs: запуск/остановка, debounce, обработка ошибок | — | [ ] |
| 9.7.7 | Тесты storage/thumbnails.rs: повреждённые изображения, слишком большие файлы, неподдерживаемые форматы | — | [ ] |

#### 9.8 — Документация

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.8.1 | Обновить SPEC_INTEGRATION.md: добавить 5 недокументированных команд (rename_tag, delete_tag_from_all, reorder_channels, rename_channel, rebuild_index) | DOC-1 | [ ] |
| 9.8.2 | Обновить DEVLOG.md: запись о результатах аудита Phase 9 | — | [ ] |

#### Порядок выполнения

```
9.1 (критические)
 ├── 9.1.1—9.1.3  Rust-бэкенд: panic, транзакции, N+1
 ├── 9.1.4—9.1.5  Безопасность: CSP, XSS
 └── 9.1.6        Инфраструктура: ESLint
      ↓
9.2 (ошибки) + 9.3 (производительность)  — параллельно
      ↓
9.4 (фронтенд) + 9.5 (клиппер)  — параллельно
      ↓
9.6 (рефакторинг)
      ↓
9.7 (тесты)  — после всех исправлений
      ↓
9.8 (документация)  — финальный шаг
```
