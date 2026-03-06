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
| 7.22 | Визуальная стилизация: overlay titlebar + drag region, Geist Sans (UI) + Geist Mono (карточки, метаданные), острые карточки без заливки, GAP 32px, sidebar без заголовка с градиентным fade | [x] |
| 7.23 | Иконки каналов в sidebar: стопка из 1–3 мини-карточек с реальными превью, веерная анимация при ховере | [x] |
| 7.24 | Fullscreen Detail: двухслойный layout (scroll + fixed metadata), Geist Mono, drag region | [x] |

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

Goal: довести проект до продакшен-качества по результатам аудитов ([AUDIT.md](AUDIT.md)). Устранить все критические и высокие проблемы, закрыть пробелы в тестовом покрытии, укрепить безопасность.

**Аудиты:**
- 01.03.2026 — первый аудит (11 агентов): 6 критических, 10 высоких, 12 средних
- 03.03.2026 — повторный аудит (10 агентов): 3 новых критических, 10 новых высоких, 8 новых средних

#### 9.1 — Критические исправления первого аудита (блокеры релиза) [COMPLETED]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.1.1 | `panic!()` → `Result` в `resolve_slug_conflict()` | CRIT-1 | [x] |
| 9.1.2 | Обернуть `upsert_block()` в `conn.unchecked_transaction()` | CRIT-2 | [x] |
| 9.1.3 | Исправить N+1: батч-запрос в `collect_blocks()` | CRIT-3 | [x] |
| 9.1.4 | Включить CSP в `tauri.conf.json` | CRIT-4 | [x] |
| 9.1.5 | Исправить XSS в `popup.js` (DOM API) | CRIT-5 | [x] |
| 9.1.6 | Установить ESLint 10 + typescript-eslint | CRIT-6 | [x] |

#### 9.2 — Высокие исправления первого аудита (частично) [COMPLETED]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.2.1 | Убрать `unwrap_or(BlockType::File)` в `row_to_block()` | HIGH-2 | [x] |
| 9.2.2 | Заменить 20x `lock().unwrap()` на `map_err` во всех commands | HIGH-3 | [x] |
| 9.2.3 | `unwrap()` → `.expect()` на `duration_since(UNIX_EPOCH)` | HIGH-4 | [x] |
| 9.2.4 | Path traversal: `canonicalize()` + `is_file()` | HIGH-5 | [x] |
| 9.2.5 | Добавить `console.error()` в пустые `catch {}` | HIGH-7 | [x] |
| 9.2.6 | Добавить индекс `idx_blocks_saved_at` | HIGH-1 | [x] |
| 9.2.7 | Добавить индекс `idx_block_tags_block_id` | HIGH-1 | [x] |

#### 9.3 — Критические исправления повторного аудита [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.3.1 | FIFO → `Map<messageId, callback>` + очистка таймеров в `onDisconnect` | CRIT-7 | [ ] |
| 9.3.2 | Откат медиафайлов при ошибке записи .md в native_host | CRIT-8 | [ ] |
| 9.3.3 | `lock().unwrap()` → `map_err` в watcher/watch.rs:60 | CRIT-9 | [ ] |

#### 9.4 — App.tsx: надёжность и производительность [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.4.1 | try/catch на все 9 async-функций (loadData, handleRenameTag, handleDeleteTagFromAll, handleCreateChannel, handleReorderTag, handleCardDrop, handleToggleTag, handleCreateTagFromMenu, handleDeleteBlock) | HIGH-11 | [ ] |
| 9.4.2 | `useMemo` на channelPreviews — убрать двойной O(N) цикл | HIGH-12 | [ ] |
| 9.4.3 | `useMemo` на фильтрацию ChannelPage | HIGH-13 | [ ] |
| 9.4.4 | `instanceof PointerEvent` вместо `as` cast | MED-12 | [ ] |

#### 9.5 — Безопасность: валидация URL [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.5.1 | Проверка протокола (http/https) перед `href` в Detail.tsx:171 | MED-8 | [ ] |
| 9.5.2 | Валидация URL в markdown-ссылках Detail.tsx:356—365 | MED-9 | [ ] |
| 9.5.3 | Валидация og:image в popup.js:276 | MED-17 | [ ] |
| 9.5.4 | `<all_urls>` → `["https://*", "http://*"]` в manifest.json | — | [ ] |

#### 9.6 — Транзакции в составных операциях [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.6.1 | Обернуть rename_tag в транзакцию | HIGH-16 | [ ] |
| 9.6.2 | Обернуть delete_tag_from_all в транзакцию | HIGH-16 | [ ] |
| 9.6.3 | Обернуть rename_channel (3 шага) в транзакцию | HIGH-17 | [ ] |
| 9.6.4 | Обернуть rebuild_index в транзакцию | HIGH-18 | [ ] |
| 9.6.5 | Обернуть import_channel в транзакцию | — | [ ] |

#### 9.7 — Производительность бэкенда [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.7.1 | SQL-запрос для проверки slug вместо загрузки всех блоков | HIGH-14 | [ ] |
| 9.7.2 | HashMap вместо линейного поиска в list_channels | HIGH-15 | [ ] |
| 9.7.3 | Убрать дублирующие вызовы get_all_tags в channels.rs | HIGH-15 | [ ] |
| 9.7.4 | FTS5: `tokenize='unicode61 remove_diacritics 0'` для кириллицы | MED-2 | [ ] |
| 9.7.5 | TOCTOU в `delete_block_files()`: ловить `ErrorKind::NotFound` | MED-4 | [ ] |
| 9.7.6 | Лимит на размер изображения перед `image::open()` | MED-5 | [ ] |
| 9.7.7 | Исправить порядок удаления в delete_block (файлы → индекс) | MED-18 | [ ] |

#### 9.8 — Веб-клиппер: надёжность [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.8.1 | Очистка таймеров при onDisconnect в background.js | CRIT-7 | [ ] |
| 9.8.2 | Таймауты на промисы в popup.js (getContextMenuData, extractMetadata, articlePromise) | — | [ ] |
| 9.8.3 | HTTP-таймауты `.timeout(Duration::from_secs(30))` в native_host | MED-6 | [ ] |
| 9.8.4 | Атомарная запись файлов (write-to-temp → rename) в native_host | MED-7 | [ ] |
| 9.8.5 | `unwrap()` → Result в native_host.rs:365, 422 | — | [ ] |
| 9.8.6 | Валидация URL в content.js перед формированием markdown-ссылок | MED-9 | [ ] |
| 9.8.7 | ext_from_url(): определять MIME из Content-Type заголовков | MED-19 | [ ] |

#### 9.9 — Обработка ошибок (оставшиеся) [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.9.1 | `.expect()` → `Result` в `lib.rs:95` — ошибка запуска Tauri | HIGH-10 | [ ] |
| 9.9.2 | Утечка слушателя в ImportDialog: паттерн `isMounted` | HIGH-6 | [ ] |
| 9.9.3 | Неочищенные промис-хэндлеры в DropZone.tsx | HIGH-19 | [ ] |
| 9.9.4 | Восстановление watcher: `watcher-error` событие, full_scan при накоплении | MED-10 | [ ] |
| 9.9.5 | Разделить ошибки импорта: recoverable vs fatal | MED-11 | [ ] |

#### 9.10 — Рефакторинг [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.10.1 | Вынести `titleFromTag()` в `lib/utils.ts` — убрать дублирование из 3 файлов | MED-13 | [ ] |
| 9.10.2 | Вынести `is_image_ext()` в `util.rs` — убрать дублирование Rust | MED-1 | [ ] |
| 9.10.3 | Заменить хардкод-цвета на семантические токены | HIGH-9 | [ ] |
| 9.10.4 | Извлечь повторяющийся CSS-класс метаданных в `@layer components` | — | [ ] |
| 9.10.5 | Убрать dead code в arena_api.rs | — | [ ] |
| 9.10.6 | `unsafe-inline` убрать из CSP (если не сломает shadcn) | MED-15 | [ ] |

#### 9.11 — Тесты: критические пробелы [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.11.1 | Тесты commands/blocks.rs: create, delete, list, error paths | — | [ ] |
| 9.11.2 | Тесты commands/tags.rs: add, remove, rename, delete_from_all | — | [ ] |
| 9.11.3 | Тесты commands/channels.rs: list, create, delete, reorder, rename | — | [ ] |
| 9.11.4 | Тесты storage/files.rs: delete (orphaned media), copy (конфликты) | — | [ ] |
| 9.11.5 | Тесты arena_api.rs: мок HTTP, пагинация, ошибки | — | [ ] |
| 9.11.6 | Тесты watcher/watch.rs: запуск/остановка, debounce | — | [ ] |
| 9.11.7 | Тесты storage/thumbnails.rs: повреждённые/большие изображения | — | [ ] |

#### 9.12 — Документация [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.12.1 | Обновить SPEC_INTEGRATION.md: добавить 5 недокументированных команд | DOC-1 | [ ] |
| 9.12.2 | Обновить DEVLOG.md: запись о повторном аудите и исправлениях | — | [ ] |

#### Порядок выполнения

```
9.3 (критические — повторный аудит)
     |
9.4 (App.tsx)  ←→  9.5 (URL-безопасность)     — параллельно
     |
9.6 (транзакции)  ←→  9.7 (производительность) — параллельно
     |
9.8 (клиппер)  ←→  9.9 (ошибки)               — параллельно
     |
9.10 (рефакторинг)
     |
9.11 (тесты)  — после всех исправлений
     |
9.12 (документация)  — финальный шаг
```

### Phase 10 — UX: навигация, сайдбар, устойчивость [COMPLETED]

Goal: полноценная клавиатурная навигация, ресайз сайдбара, исправление взаимодействия Detail с Tauri drag region, устойчивость к iCloud-оптимизации.

| # | Task | Status |
|---|------|--------|
| 10.1 | Ресайз сайдбара: pill-хэндл (Things-стиль), `useSidebarResize` хук, двойной клик для сворачивания/разворачивания | [x] |
| 10.2 | Detail: рефакторинг с Radix Dialog на plain div (`absolute inset-0 z-10` внутри `<main isolation: isolate>`) | [x] |
| 10.3 | Исправление кнопки X в Detail: перенос ниже 32px Tauri drag region (`top-10 right-4`) | [x] |
| 10.4 | Исправление навигации сайдбара при открытом Detail: `useEffect` на `location.pathname` сбрасывает `selectedBlock` | [x] |
| 10.5 | Клавиатурная навигация в Grid: визуальная навигация по `getBoundingClientRect()` (4 стрелки + Enter + Esc), `focusedBlockId` state, автоподскрол, восстановление фокуса при закрытии Detail | [x] |
| 10.6 | Клавиатурная навигация в Detail: влево/вправо (линейная), capture phase + stopPropagation, пропуск модификаторов | [x] |
| 10.7 | Переключение каналов Opt+Cmd+Up/Down: навигация по `orderedTags`, автоподскрол сайдбара к `[aria-current="page"]` | [x] |
| 10.8 | Устойчивость к iCloud: сброс ошибки загрузки карточек через событие `vault-refreshed` при `loadData` | [x] |
| 10.9 | `activeBlocks` memo: фильтрация по текущему каналу на уровне App, исправление бага навигации Detail за пределы канала | [x] |

### Phase 11 — Редизайн сайдбара и тулбара [IN PROGRESS]

Goal: табличный вид сайдбара (название + превью + счётчик), кастомный тулбар, Rust-команда для проверенных превью.

| # | Task | Status |
|---|------|--------|
| 11.1 | Табличный вид сайдбара: строка = название (flex-1) + карточки в ряд (flex-1) + счётчик (w-8) | [x] |
| 11.2 | Rust-команда `list_channel_previews`: `thumb_path.exists()`, возврат только реальных slug'ов | [x] |
| 11.3 | Кастомный `<header>` тулбар (h-8, 32px) вместо overlay drag region | [x] |
| 11.4 | Направляющие между строками (`border-b`) | [x] |
| 11.5 | Сохранение классического вида Sidebar/ChannelIcon как `.classic.tsx` | [x] |
| 11.6 | Убрана нижняя панель сайдбара (Import, Search) | [x] |
| 11.7 | Наполнение тулбара (поиск, действия) | [ ] |
| 11.8 | Финальная калибровка отступов и типографики | [ ] |

### Phase 12 — Редизайн расширения: Vite-сборка + единая дизайн-система [COMPLETED]

Goal: расширение собирается через Vite, использует те же React-компоненты и CSS-токены, что и основное приложение. Один источник правды — дрейф дизайна невозможен.

**Принцип:** расширение — проекция основного приложения в браузер. Те же шрифты (Geist, Geist Mono), те же токены (`global.css`), те же компоненты (`@/components/ui/*`). Различия только в адаптере (native messaging vs Tauri IPC) и в layout (popup vs fullscreen).

#### 12.1 — Инфраструктура сборки

| # | Task | Status |
|---|------|--------|
| 12.1.1 | `vite.extension.config.ts`: отдельная Vite-конфигурация, entry point `extension/popup/main.tsx`, output в `extension/dist/` | [x] |
| 12.1.2 | Скрипт `bun run build:extension` в `package.json` | [x] |
| 12.1.3 | Алиас `@/` → `src/` в конфигурации расширения (общие компоненты) | [x] |
| 12.1.4 | Исключить Tauri-специфичный код из сборки расширения (tree-shaking или условный импорт) | [x] |
| 12.1.5 | Шрифты: копировать `public/fonts/*.woff2` в `extension/dist/fonts/`, обновить `@font-face` пути | [x] |
| 12.1.6 | `manifest.json`: указать `popup: "dist/popup.html"` | [x] |

#### 12.2 — React-попап

| # | Task | Status |
|---|------|--------|
| 12.2.1 | `extension/popup/main.tsx`: React entry point, рендер `<PopupApp />` | [x] |
| 12.2.2 | `extension/popup/PopupApp.tsx`: корневой компонент, состояния (loading → error → main) | [x] |
| 12.2.3 | Адаптер `extension/popup/lib/messaging.ts`: типизированный native messaging с таймаутами (исправление CRIT-7 из аудита) | [x] |
| 12.2.4 | Хук `useClipperState()`: вся бизнес-логика попапа (init, каналы, save, недавние) | [x] |
| 12.2.5 | — (объединено с 12.2.4) | [x] |

#### 12.3 — Компоненты попапа (на базе shadcn/ui)

| # | Task | Status |
|---|------|--------|
| 12.3.1 | `PreviewCard`: thumbnail + title input + domain. Использует `<Input>` из shadcn | [x] |
| 12.3.2 | `TypeSwitcher`: Content / Link. Стилизован как type-switcher, использует `<Button variant="ghost">` | [x] |
| 12.3.3 | `ChannelList`: поиск + список каналов с чекбоксами. Использует `<Input>`, `<ScrollArea>` | [x] |
| 12.3.4 | `SaveButton`: кнопка сохранения. `<Button variant="default">` полной ширины + `<kbd>` | [x] |
| 12.3.5 | `StatusBar`: статус после сохранения (success/error) | [x] |
| 12.3.6 | Состояние загрузки: спиннер (существующий CSS-паттерн) | [x] |
| 12.3.7 | Состояние ошибки: иконка + сообщение | [x] |

#### 12.4 — Стилизация

| # | Task | Status |
|---|------|--------|
| 12.4.1 | Импорт `src/styles/global.css` — все токены, шрифты, base-стили наследуются автоматически | [x] |
| 12.4.2 | `extension/popup/popup-layout.css`: только popup-размеры (360x600), импортирует global.css | [x] |
| 12.4.3 | Старый `popup.css` перемещён в `_legacy/` | [x] |
| 12.4.4 | Проверка: все размеры текста строго 12/14/18px, веса 400/600, отступы из шкалы | [x] |

#### 12.5 — Safari extension

| # | Task | Status |
|---|------|--------|
| 12.5.1 | Safari manifest обновлён: `dist/index.html` | [x] |
| 12.5.2 | Собранный dist копируется в Safari Resources через `build:extension` скрипт | [x] |
| 12.5.3 | Старый popup Safari перемещён в `_legacy/` | [x] |
| 12.5.4 | Пересборка Xcode-проекта с новым попапом | [ ] |

#### 12.6 — Миграция логики

| # | Task | Status |
|---|------|--------|
| 12.6.1 | Перенести логику из `popup.js` в React-хуки и компоненты | [x] |
| 12.6.2 | Типизировать native messaging протокол (TypeScript интерфейсы запросов/ответов) | [x] |
| 12.6.3 | Старый `popup.js` перемещён в `_legacy/` — вся логика в React | [x] |
| 12.6.4 | `background.js` и `content.js` — оставлены как есть (не зависят от UI) | [x] |

#### 12.7 — Проверка и очистка

| # | Task | Status |
|---|------|--------|
| 12.7.1 | Визуальное сравнение: попап расширения vs основное приложение (шрифты, цвета, отступы) | [ ] |
| 12.7.2 | Проверка на `about:blank`, PDF, `chrome://` — popup должен работать | [ ] |
| 12.7.3 | Проверка размера расширения: ~270 КБ gzip (React + шрифты + Tailwind) | [x] |
| 12.7.4 | `bun run lint` — расширение проходит те же правила ESLint | [x] |
| 12.7.5 | Обновить SPEC_CLIPPER.md: новая архитектура сборки | [x] |
| 12.7.6 | Обновить DESIGN_SYSTEM.md: раздел «Расширение» | [x] |

#### Порядок выполнения

```
12.1 (инфраструктура сборки)
  ↓
12.2 (React entry + хуки)  →  12.3 (компоненты)
  ↓
12.4 (стилизация)
  ↓
12.6 (миграция логики из popup.js)
  ↓
12.5 (Safari)  ←→  12.7 (проверка)  — параллельно
```
