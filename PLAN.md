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

### Phase 9 — Аудит и укрепление кодовой базы [DONE]

Goal: довести проект до продакшен-качества по результатам аудитов ([AUDIT.md](AUDIT.md)). Устранить все критические и высокие проблемы, закрыть пробелы в тестовом покрытии, укрепить безопасность.

**Аудиты:**
- 01.03.2026 — первый аудит (11 агентов): 6 критических, 10 высоких, 12 средних
- 03.03.2026 — повторный аудит (10 агентов): 3 новых критических, 10 новых высоких, 8 новых средних
- 07.03.2026 — третий аудит (10 агентов): 5 новых критических, 11 новых высоких, 20 новых средних. Системные проблемы: масштабируемость O(N), безопасность IPC, устаревшая документация

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

#### 9.3 — Критические исправления повторного и третьего аудитов [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.3.1 | FIFO → `Map<messageId, callback>` + очистка таймеров в `onDisconnect` | CRIT-7 | [ ] |
| 9.3.2 | Откат медиафайлов при ошибке записи .md в native_host | CRIT-8 | [ ] |
| 9.3.3 | `lock().unwrap()` → `map_err` в watcher/watch.rs:60 | CRIT-9 | [ ] |
| 9.3.4 | Валидатор slug на IPC-границе: `^[a-z0-9-]+$` | CRIT-10 | [ ] |
| 9.3.5 | Route-scoped `list_grid_blocks(current_tag)` без per-block tags; следующая цель — ещё более лёгкий first-screen DTO | CRIT-11 | [x] |
| 9.3.6 | SQL-проверка slug вместо загрузки всех блоков в create_block | CRIT-12 | [ ] |
| 9.3.7 | `has_thumbnail` в SQLite вместо N syscall-ов в list_channel_previews | CRIT-13 | [ ] |
| 9.3.8 | `catch_unwind` в потоке thumb-gen | CRIT-14 | [x] |
| 9.3.9 | `list_channel_previews` без полного `list_blocks_light()`: SQL top-N slugs для `__all__` и per-tag | PERF-1 | [x] |

#### 9.4 — App.tsx: надёжность и производительность [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.4.1 | try/catch на все 9 async-функций (loadData, handleRenameTag, handleDeleteTagFromAll, handleCreateChannel, handleReorderTag, handleCardDrop, handleToggleTag, handleCreateTagFromMenu, handleDeleteBlock) | HIGH-11 | [~] частично — `loadData` и vault sync path закрыты |
| 9.4.2 | `useMemo` на channelPreviews — убрать двойной O(N) цикл | HIGH-12 | [x] решено сменой архитектуры: server-derived previews + SQL top-N |
| 9.4.3 | `useMemo` на фильтрацию ChannelPage | HIGH-13 | [ ] |
| 9.4.4 | `instanceof PointerEvent` вместо `as` cast | MED-12 | [ ] |
| 9.4.5 | Открытие vault по snapshot без блокирующего `full_scan()`, фоновые `vault-sync-*` events, switch без `window.location.reload()` | PERF-2 | [x] |
| 9.4.6 | Guard против stale async-ответов при switch vault (`vaultPathRef` + request id) | PERF-3 | [x] |

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
| 9.7.1 | SQL-запрос для проверки slug вместо загрузки всех блоков | HIGH-14, CRIT-12 | [ ] |
| 9.7.2 | HashMap вместо линейного поиска в list_channels | HIGH-15 | [x] |
| 9.7.3 | Убрать дублирующие вызовы get_all_tags в channels.rs | HIGH-15 | [ ] |
| 9.7.4 | FTS5: `tokenize='unicode61 remove_diacritics 0'` для кириллицы | MED-2 | [ ] |
| 9.7.5 | TOCTOU в `delete_block_files()`: ловить `ErrorKind::NotFound` | MED-4 | [ ] |
| 9.7.6 | Лимит на размер изображения перед `image::open()` | MED-5 | [ ] |
| 9.7.7 | Исправить порядок удаления в delete_block (файлы → индекс) | MED-18 | [ ] |
| 9.7.8 | Одна транзакция на весь `full_scan` вместо 10K отдельных | HIGH-27 | [ ] |
| 9.7.9 | Батчинг IN-запроса тегов по 500-900 | HIGH-28 | [ ] |
| 9.7.10 | `React.memo` на Card + `useCallback` на обработчики | HIGH-26 | [ ] |
| 9.7.11 | `PRAGMA busy_timeout = 5000` в apply_pragmas | MED-31 | [ ] |
| 9.7.12 | Индекс на `block_type` | MED-37 | [ ] |

#### 9.8 — Веб-клиппер: надёжность [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.8.1 | Очистка таймеров при onDisconnect в background.js | CRIT-7 | [ ] |
| 9.8.2 | Таймауты на промисы в popup.js (getContextMenuData, extractMetadata, articlePromise) | — | [ ] |
| 9.8.3 | HTTP-таймауты `.timeout(Duration::from_secs(30))` в native_host | MED-6, HIGH-24 | [ ] |
| 9.8.4 | Атомарная запись файлов (write-to-temp → rename) в native_host | MED-7 | [ ] |
| 9.8.5 | `unwrap()` → Result в native_host.rs:384, 441 | — | [ ] |
| 9.8.6 | Валидация URL в content.js перед формированием markdown-ссылок | MED-9 | [ ] |
| 9.8.7 | ext_from_url(): определять MIME из Content-Type заголовков | MED-19 | [ ] |
| 9.8.8 | Сломанная ссылка popup в контекстном меню: `popup.html` → `dist/index.html` | HIGH-29 | [ ] |
| 9.8.9 | SSRF: валидация схемы (https only) + запрет приватных IP в download_file | HIGH-21 | [ ] |
| 9.8.10 | Валидация тега в native host create_channel | MED-35 | [ ] |
| 9.8.11 | `<all_urls>` → `chrome.scripting.executeScript()` по требованию | MED-34 | [ ] |

#### 9.9 — Обработка ошибок (оставшиеся) [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.9.1 | `.expect()` → `Result` в `lib.rs:95` — ошибка запуска Tauri | HIGH-10 | [ ] |
| 9.9.2 | Утечка слушателя в ImportDialog: паттерн `isMounted` | HIGH-6 | [ ] |
| 9.9.3 | Неочищенные промис-хэндлеры в DropZone.tsx | HIGH-19 | [ ] |
| 9.9.4 | Восстановление watcher: `watcher-error` событие, full_scan при накоплении | MED-10 | [ ] |
| 9.9.5 | Разделить ошибки импорта: recoverable vs fatal | MED-11 | [ ] |
| 9.9.6 | Deadlock risk: задокументировать порядок блокировки мьютексов или объединить state | HIGH-22 | [ ] |
| 9.9.7 | Mutex на время импорта: разбить на короткие блокировки | HIGH-23 | [ ] |
| 9.9.8 | Утечка таймера в Search.tsx: cleanup useEffect | MED-27 | [ ] |
| 9.9.9 | Гонка записи thumbnail: атомарная запись (temp + rename) | MED-32 | [ ] |

#### 9.10 — Рефакторинг [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.10.1 | Вынести `titleFromTag()` в `lib/utils.ts` — убрать дублирование из 3 файлов | MED-13 | [ ] |
| 9.10.2 | Вынести `is_image_ext()` в `util.rs` — убрать дублирование Rust | MED-1 | [ ] |
| 9.10.3 | Заменить хардкод-цвета на семантические токены | HIGH-9 | [ ] |
| 9.10.4 | Извлечь повторяющийся CSS-класс метаданных в `@layer components` | — | [ ] |
| 9.10.5 | Убрать dead code в arena_api.rs | — | [ ] |
| 9.10.6 | `unsafe-inline` убрать из CSP (если не сломает shadcn) | MED-15 | [ ] |
| 9.10.7 | Вынести бизнес-логику из commands/ в domain-сервисы | MED-21 | [ ] |
| 9.10.8 | Прямой `std::fs::write` в commands/ → storage::files | MED-22 | [ ] |
| 9.10.9 | Удалить закомментированный DropZone или включить | MED-26 | [x] |
| 9.10.10 | Подключить ImportDialog (добавить триггер) или убрать | MED-25 | [ ] |
| 9.10.11 | Удалить `popup/_legacy/` | MED-38 | [ ] |
| 9.10.12 | Удалить неиспользуемые экспорты из commands.ts | MED-39 | [ ] |

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
| 9.12.1 | Обновить SPEC_INTEGRATION.md: добавить 6 недокументированных команд | DOC-1, HIGH-30 | [ ] |
| 9.12.2 | Обновить DEVLOG.md: запись о повторном аудите и исправлениях | — | [ ] |
| 9.12.3 | ARCHITECTURE.md: SQLite-схема (8+ расхождений с кодом) | HIGH-30 | [ ] |
| 9.12.4 | SPEC_DOMAIN.md: thumb_path `.webp` → `.jpg` | MED-36 | [ ] |
| 9.12.5 | SPEC_STORAGE.md: IndexedBlock — добавить поля source, width, height, author, body | — | [ ] |
| 9.12.6 | SPEC_FRONTEND.md: обновить IPC layer (13 → 20 команд), Grid (virtual → chunked) | — | [ ] |

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
| 11.9 | Текстовые миниатюры статей: `generate_text_thumbnail()` (ab_glyph + imageproc, Noto Sans 28KB embedded) | [x] |
| 11.10 | Оптимизация миниатюр: O1 — пропуск свежих (mtime), O2 — LazyLock для шрифта, O3 — фоновая генерация в full_scan | [x] |
| 11.11 | Снятие фильтра BlockType в `list_channel_previews` — статьи появляются в сайдбаре | [x] |

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

### Phase 13 — Видео-блоки: YouTube embed + транскрипт [IN PROGRESS]

Goal: полноценная поддержка видео-страниц в клиппере и основном приложении. YouTube iframe в Detail, транскрипт через Defuddle.

| # | Task | Status |
|---|------|--------|
| 13.1 | Клиппер: TypeSwitcher на видео-страницах, play-кнопка в превью | [x] |
| 13.2 | Клиппер: видео-Content сохраняется как block_type=video с URL | [x] |
| 13.3 | Detail.tsx: YouTube iframe embed для видео-блоков с URL | [x] |
| 13.4 | Detail.tsx: body ниже видео (подготовка к транскрипту) | [x] |
| 13.5 | Замена Readability+Turndown на Defuddle в content.js | [x] |
| 13.6 | Извлечение транскрипта YouTube через Defuddle или API | [x] |

### Phase M1 — Rust core UniFFI bindings [COMPLETED]

| # | Task | Status |
|---|------|--------|
| M1.1 | Cargo workspace (root + core-ffi) | [x] |
| M1.2 | Feature gate `desktop` для Tauri-зависимостей | [x] |
| M1.3 | core-ffi crate: ArenaVault, FfiLightBlock, ArenaError | [x] |
| M1.4 | iOS targets (aarch64-apple-ios, aarch64-apple-ios-sim) | [x] |
| M1.5 | Swift bindings (uniffi-bindgen) | [x] |
| M1.6 | xcframework для device + simulator | [x] |

### Phase M2 — iOS приложение [IN PROGRESS]

| # | Task | Status |
|---|------|--------|
| M2.1 | Xcode project (xcodegen), SwiftUI scaffold | [x] |
| M2.2 | scanVault() — индексация .md файлов | [x] |
| M2.3 | GridView с карточками (smoke test) | [x] |
| M2.4 | Дизайн-система: тёмная тема, цвета, типографика | [x] |
| M2.5 | Thumbnails и медиа в карточках | [x] |
| M2.5a | Полноэкранный режим (UILaunchScreen) | [x] |
| M2.5b | Видео-автоплей в ленте и Detail (AVPlayerLooper) | [x] |
| M2.6 | Channel list / навигация | [x] |
| M2.7 | Detail view (просмотр блока) | [x] |

### Phase 10 — Виртуализированная masonry-сетка [IN PROGRESS]

Goal: настоящая виртуализация для 10000+ блоков. Два пути через feature detection.

| # | Task | Status |
|---|------|--------|
| 10.1 | CSS Grid Lanes + content-visibility: auto (WebKit path) | [x] |
| 10.2 | `@virtuoso.dev/masonry` fallback (Chrome/Firefox) | [x] |
| 10.3 | Feature detection `CSS.supports("display", "grid-lanes")` | [x] |
| 10.4 | Собственный `VirtualMasonryGrid`: absolute positioning + visible window + overscan | [x] |
| 10.5 | Layout engine + cache высот карточек для быстрого resize и больших разделов | [x] |
| 10.6 | Scroll anchoring при ресайзе окна и сайдбара | [REVERTED] См. DEVLOG 11.04.2026 (late+3): anchoring не работает в masonry с non-uniform shifts, feedback loop через программный scrollTop |

### Phase 11 — Zero-Jank Masonry [SPEC]

Goal: полная переработка grid-архитектуры под четыре продуктовых требования (120fps scroll без прыжков, мгновенный resize, 1000 ≈ 10000, мгновенный channel switch) без компромиссов. Работает одинаково на desktop Tauri и на будущем web-деплое.

SPEC: [SPEC_GRID.md](SPEC_GRID.md) — детальное описание архитектуры, модулей, API контрактов, performance targets, migration plan.

Корневой принцип: **все высоты карточек известны до вставки в layout через Canvas `measureText` в Web Worker'е**. Никакого DOM measurement на hot path, никаких корректировок, никакого scroll anchoring. Прыжков не может существовать, потому что нет причины для их генерации.

| # | Task | Status |
|---|------|--------|
| 11.1 | SPEC_GRID.md — полная спецификация архитектуры | [x] |
| 11.2 | `src/workers/fontMetrics.worker.ts` + `src/lib/fontMetrics.ts` — OffscreenCanvas measureText в Worker, IndexedDB cache word_widths | [ ] |
| 11.3 | `src/lib/wordWrap.ts` + `src/lib/cardHeight.ts` — pure функции для детерминистической высоты | [ ] |
| 11.4 | `src/lib/masonryLayout.ts` — bucket-based visibility index (расширение существующего модуля) | [ ] |
| 11.5 | `src/lib/layoutCache.ts` — LRU cache для layouts каналов | [ ] |
| 11.6 | `src/hooks/useGridScroll.ts` — `useSyncExternalStore` scroll state без React ре-рендеров | [ ] |
| 11.7 | `src/components/Grid.tsx` — rewrite: dual-path (native grid-lanes + virtualized JS), удаление measurement infrastructure | [ ] |
| 11.8 | `src/components/Card.tsx` — `will-change: transform`, `translate3d`, фиксация line-height | [ ] |
| 11.9 | Визуальная проверка на реальном vault'е + замеры FPS через DevTools | [ ] |

### Phase 12 — Thumbnail pipeline: two-phase through WebView decoder [IN PROGRESS]

Goal: удовлетворить четыре продуктовых инварианта для sidebar thumbs (мгновенное появление, корректность для всех форматов клиппера, baked text для pure-text / real image для articles с media, плавный скролл 100+ каналов × 10 thumbs) без компромиссов. Устранить зависимость от Rust crate stack для decode экзотических форматов (VP8X WebP, HEIC, AVIF, HEVC, fragmented MP4).

SPEC: [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) — полная архитектура, протоколы событий, worker contract, failure modes, testing plan.

Корневое решение: two-phase pipeline. **Phase 1** — Rust синхронно пишет thumb при save (JPEG/PNG через content sniff → real thumb; всё остальное → text placeholder, всегда успешно, <150ms latency). **Phase 2** — main app в фоне upgradeит placeholders через Web Worker (`createImageBitmap` + `OffscreenCanvas.convertToBlob`), WebView native decoder покрывает весь набор форматов которые клиппер может сохранить. Sidebar обновляется через Tauri events (block:added, thumb:updated) вместо polling.

| # | Task | Status |
|---|------|--------|
| 12.1 | SPEC_THUMBNAILS.md — полная спецификация архитектуры | [x] |
| 12.2 | Phase A: content sniff в `generate_for_block` (`is_rust_decodable` — first 6 bytes → JPEG/PNG/GIF direct, else text placeholder). Rebuild + install native host | [x] |
| 12.3 | Phase B.1: `src-tauri/src/commands/thumbnails.rs` — `save_thumb`, `list_pending_thumb_upgrades` | [x] |
| 12.4 | Phase B.2: Tauri events в `watcher::handler::index_md_file` — `block:added`, `block:removed`, `thumb:updated`, `thumb:upgrade-requested` | [x] |
| 12.5 | Phase B.3: `src/workers/thumbWorker.ts` — image через `createImageBitmap` + `OffscreenCanvas.convertToBlob`, video stub (VideoDecoder API не реализован) | [x] |
| 12.6 | Phase B.4: `src/hooks/useThumbnailUpgrade.ts` + `src/hooks/useChannelPreviewsEvents.ts` — event subscribers, worker queue coordination | [x] |
| 12.7 | Phase B.5: wire up в `App.tsx`, startup call `list_pending_thumb_upgrades` | [x] |
| 12.8 | Phase C: виртуализация Sidebar — CSS `content-visibility: auto` + `contain-intrinsic-size` на TagNavItem, отключение при drag | [x] |
| 12.9 | Phase D (deferred): удаление `openh264`, `mp4` crates — заблокировано, worker video decode stub'нут | [-] |
| 12.10 | Cache-bust fix: `list_channel_previews` возвращает `mtime` per thumb, frontend использует `?m=<mtime>` вместо raw URL | [x] |
| 12.11 | Manual QA: visual regression на representative vault | [ ] |

### Backlog

| Task | Description |
|---|---|
| Validate vault | Команда проверки целостности vault: валидация frontmatter, осиротевшие медиа, консистентность индекса, автоисправление |
